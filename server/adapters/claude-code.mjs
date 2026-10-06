// Claude Code source adapter (see adapters/index.mjs for the adapter interface).
//   projects: every folder under ~/.claude/projects is one working directory. Its path comes from the "cwd" at
//             the head of the newest session file; a folder without session files (only memory/ left, since
//             Claude Code deletes old logs) is resolved from its name (slug) by a guided walk from the drive root.
//   project items: <project>/.claude/skills/*/SKILL.md and <project>/.claude/agents/**/*.md
//   global items: personal (~/.claude/skills, ~/.claude/agents), claudeai (synced from claude.ai), plugin
//             (installed_plugins.json) and builtin (Claude Code's built-in agent types)
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readJson, normPath, slugify } from '../util.mjs';
import { DirLister, PLAIN_LISTER, exists, listDirs, safeDirs, skillDirs, walkMd } from '../fsutil.mjs';

// Descriptions of the built-in agent types (English; the page shows them in its language: format.js BUILTIN_AGENT_KEYS)
export const BUILTIN_AGENTS = {
  'general-purpose': 'General-purpose agent: research, search, multi-step work.',
  Explore: 'Explore agent: read-only broad search, returns only the conclusion.',
  Plan: 'Planning agent: implementation plan and architecture options.',
  'web-fetch': 'Web reading agent: fetches and summarizes pages.',
  fork: 'Fork: a copy that inherits the main session\'s context.',
  'workflow-subagent': 'Workflow worker: one step of a multi-agent script.',
  'claude-code-guide': 'Claude Code guide: questions about features and settings.',
  'statusline-setup': 'Status line setup.',
  claude: 'General Claude agent.',
};

// How much of a session log head is read to find the working directory, and how many of a folder's newest
// session files are tried before falling back to the folder name
const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 256 * 1024;
const HEAD_TRIES = 3;
// Scratchpad and task folders of Claude Code sessions are not projects
const SCRATCH_SLUG = /-temp-claude-/i;
const SLUG_MAX_DEPTH = 40;

// First "cwd" string in the first lines of a JSONL file (partial last line ignored); null if none.
// A StringDecoder keeps a multi-byte UTF-8 character split across two chunks intact.
export function readHeadCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let pos = 0;
    const buf = Buffer.alloc(HEAD_CHUNK);
    while (pos < HEAD_MAX) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      text += decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      text = lines.pop(); // may be incomplete
      for (const line of lines) {
        if (!line.includes('"cwd"')) continue;
        try {
          const o = JSON.parse(line);
          if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
        } catch {
          /* a broken line does not stop the search */
        }
      }
      if (n < buf.length) break;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Real folder for a Claude Code folder name. The name is the path with every character other than a letter or
// a digit turned into '-' ("C:\My App" -> "C--My-App"), so it cannot simply be turned back. Walk from the drive
// root and at every level descend only into sub folders whose own slug is a prefix of what is left; names with
// spaces, dots or non-ASCII letters therefore match. Only a single existing match is accepted: an ambiguous name
// ("a b" and "a-b" side by side) or no match gives null. readDirs(dir) lists sub folder names (can be cached).
export function resolveSlug(slug, readDirs = (d) => listDirs(d, { hidden: true })) {
  const m = /^([A-Za-z])--(.+)$/.exec(String(slug || ''));
  if (!m) return null;
  const target = m[2].toLowerCase();
  const found = [];
  const walk = (dir, rest, depth) => {
    if (found.length > 1 || depth > SLUG_MAX_DEPTH) return;
    for (const name of readDirs(dir)) {
      const s = slugify(name).toLowerCase();
      if (!s) continue;
      if (rest === s) found.push(path.join(dir, name));
      else if (rest.startsWith(s + '-')) walk(path.join(dir, name), rest.slice(s.length + 1), depth + 1);
      if (found.length > 1) return;
    }
  };
  walk(`${m[1].toUpperCase()}:\\`, target, 0);
  return found.length === 1 ? found[0] : null;
}

// Working directory of one log folder, cached by the folder's modification time (it changes when a session file
// is created or deleted; appending to a session does not change it). Returns { cwd, lastSeenAt, via }.
function folderInfo(dir, slug, ctx, readDirs) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return null;
  }
  const cache = ctx.cache.folders || (ctx.cache.folders = new Map());
  let hit = cache.get(dir);
  if (!hit || hit.dirMtimeMs !== st.mtimeMs) {
    let files = [];
    try {
      files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
        .map((d) => {
          const f = path.join(dir, d.name);
          try {
            return { f, t: fs.statSync(f).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.t - a.t);
    } catch {
      files = [];
    }
    let cwd = null;
    let from = 'log';
    for (const { f } of files.slice(0, HEAD_TRIES)) {
      cwd = readHeadCwd(f);
      if (cwd) break;
    }
    // No usable session file (Claude Code deleted the old logs): resolve the folder name
    if (!cwd && !SCRATCH_SLUG.test(slug)) {
      cwd = resolveSlug(slug, readDirs);
      from = 'name';
    }
    hit = { dirMtimeMs: st.mtimeMs, newest: files[0]?.f || null, cwd, from };
    cache.set(dir, hit);
  }
  hit.gen = ctx.cache.gen;
  let lastSeenAt = st.mtimeMs;
  try {
    if (hit.newest) lastSeenAt = fs.statSync(hit.newest).mtimeMs;
  } catch {
    /* the folder time stands in */
  }
  return { cwd: hit.cwd, lastSeenAt, from: hit.from };
}

function pluginItems(dir, pluginName, extra, ctx, out) {
  const ls = ctx.ls || PLAIN_LISTER;
  for (const d of safeDirs(path.join(dir, 'skills'), ls)) {
    const file = path.join(dir, 'skills', d, 'SKILL.md');
    const fm = ctx.frontmatter(file);
    if (!fm) continue;
    out.push({ kind: 'skill', name: `${pluginName}:${fm.name || d}`, path: file, description: fm.description || '', ...extra });
  }
  for (const f of walkMd(path.join(dir, 'agents'), ls)) {
    const fm = ctx.frontmatter(f) || {};
    out.push({ kind: 'agent', name: `${pluginName}:${fm.name || path.basename(f, '.md')}`, path: f, description: fm.description || '', ...extra });
  }
}

export const claudeCode = {
  id: 'claude-code',
  name: 'Claude Code',

  detect(ctx) {
    return exists(ctx.claudeDir);
  },

  // [{ path, lastSeenAt, hint }]: hint is the log folder name (matches registry memory slugs)
  findProjects(ctx) {
    const out = [];
    // One readdir per folder per pass, shared by all name walks (and with the other adapters through the lister of
    // the pass)
    const ls = ctx.ls || new DirLister();
    const readDirs = (d) => listDirs(d, { hidden: true, ls });
    ctx.cache.gen = (ctx.cache.gen || 0) + 1;
    for (const slug of safeDirs(ctx.projectsDir)) {
      const info = folderInfo(path.join(ctx.projectsDir, slug), slug, ctx, readDirs);
      if (info?.cwd) out.push({ path: info.cwd, lastSeenAt: info.lastSeenAt, hint: slug });
    }
    // Log folders that are gone drop out of the cache
    const cache = ctx.cache.folders;
    if (cache) for (const [dir, e] of cache) if (e.gen !== ctx.cache.gen) cache.delete(dir);
    return out;
  },

  // Skills and agents that belong to one project folder. A folder whose .claude is the personal folder
  // (the home folder) has none: personal items are not counted again as project items.
  findItems(projectPath, ctx) {
    const base = path.join(projectPath, '.claude');
    if (normPath(base) === normPath(ctx.claudeDir)) return [];
    const ls = ctx.ls || PLAIN_LISTER;
    const out = [];
    for (const d of safeDirs(path.join(base, 'skills'), ls)) {
      const file = path.join(base, 'skills', d, 'SKILL.md');
      const fm = ctx.frontmatter(file);
      if (!fm) continue;
      out.push({ kind: 'skill', name: fm.name || d, path: file, source: 'project', description: fm.description || '' });
    }
    for (const f of walkMd(path.join(base, 'agents'), ls)) {
      const fm = ctx.frontmatter(f) || {};
      out.push({ kind: 'agent', name: fm.name || path.basename(f, '.md'), path: f, source: 'project', description: fm.description || '' });
    }
    return out;
  },

  // Items active outside any single project: personal, claude.ai synced, plugins, built-in agent types
  findGlobalItems(ctx) {
    return [...claudeCode.globalItemSteps(ctx)].flat();
  },

  // The same items in parts (adapters/index.mjs): the personal and claude.ai skills, then one part per plugin
  *globalItemSteps(ctx) {
    const out = [];
    const ls = ctx.ls || PLAIN_LISTER;
    const skillsDir = path.join(ctx.claudeDir, 'skills');
    // Personal: active in every project. "synced" holds the skills synced from claude.ai
    for (const d of safeDirs(skillsDir, ls)) {
      if (d === 'synced') continue;
      const file = path.join(skillsDir, d, 'SKILL.md');
      const fm = ctx.frontmatter(file);
      if (!fm) continue;
      out.push({ kind: 'skill', name: fm.name || d, path: file, source: 'personal', category: 'personal', description: fm.description || '', global: true });
    }
    for (const f of walkMd(path.join(ctx.claudeDir, 'agents'), ls)) {
      const fm = ctx.frontmatter(f) || {};
      out.push({ kind: 'agent', name: fm.name || path.basename(f, '.md'), path: f, source: 'personal', category: 'personal', description: fm.description || '', global: true });
    }

    // Skills synced from claude.ai: synced/<name>/SKILL.md or (as on real machines) synced/<account>/<name>/SKILL.md
    for (const dir of skillDirs(path.join(skillsDir, 'synced'), 2, ls)) {
      const file = path.join(dir, 'SKILL.md');
      const fm = ctx.frontmatter(file) || {};
      out.push({ kind: 'skill', name: fm.name || path.basename(dir), path: file, source: 'claudeai', category: 'claudeai', description: fm.description || '', global: true });
    }
    yield out.splice(0);
    // Plugins synced from claude.ai: ~/.claude/plugins/synced/<account>/<folder> (name from .claude-plugin/plugin.json)
    const syncedPlugins = path.join(ctx.claudeDir, 'plugins', 'synced');
    for (const bucket of safeDirs(syncedPlugins, ls)) {
      const bdir = path.join(syncedPlugins, bucket);
      for (const folder of safeDirs(bdir, ls)) {
        const dir = path.join(bdir, folder);
        const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
        if (!manifest) continue; // not a plugin
        const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : folder.replace(/~.*$/, '');
        const meta = readJson(path.join(bdir, `${folder}.meta.json`)) || {};
        const market = typeof meta.marketplace_name === 'string' ? meta.marketplace_name : '';
        // Observed value is "available" (loaded in Claude Code sessions); an explicit off-like preference means disabled
        const pref = typeof meta.installation_preference === 'string' ? meta.installation_preference : '';
        const enabled = !/^(disabled|off|hidden|unavailable|blocked)$/i.test(pref);
        const pluginId = market ? `${name}@${market}` : name;
        out.push({ kind: 'plugin', name, path: dir, source: 'claudeai', category: 'claudeai', description: manifest.description || `Plugin synced from claude.ai${market ? ` · ${market}` : ''}`, global: enabled, enabled, pluginId });
        pluginItems(dir, name, { source: 'claudeai', category: 'claudeai', plugin: pluginId, global: enabled, enabled }, ctx, out);
        yield out.splice(0);
      }
    }

    // Plugins: installed_plugins.json {"version":2,"plugins":{"<name>@<marketplace>":[{"scope","installPath","version",...}]}}.
    // An entry without an install folder (installPath) is skipped silently.
    const inst = readJson(path.join(ctx.claudeDir, 'plugins', 'installed_plugins.json'));
    const settings = readJson(path.join(ctx.claudeDir, 'settings.json')) || {};
    const enabledMap = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
    const plugins = inst?.plugins && typeof inst.plugins === 'object' && !Array.isArray(inst.plugins) ? inst.plugins : {};
    for (const [id, entries] of Object.entries(plugins)) {
      const list = (Array.isArray(entries) ? entries : [entries]).filter((e) => e && typeof e === 'object');
      const dirs = [...new Set(list.map((e) => (typeof e.installPath === 'string' && e.installPath ? e.installPath : null)).filter(Boolean))];
      const at = id.lastIndexOf('@');
      const name = at > 0 ? id.slice(0, at) : id;
      const market = at > 0 ? id.slice(at + 1) : '';
      if (!name || !dirs.length) continue;
      const enabled = enabledMap[id] === true;
      const version = list.find((e) => typeof e.version === 'string')?.version;
      out.push({
        kind: 'plugin',
        name,
        path: dirs[0],
        source: 'plugin',
        category: market || 'plugin',
        description: `${market ? `From the ${market} marketplace · ` : ''}version ${version || '?'}`,
        global: enabled,
        enabled,
        pluginId: id,
      });
      for (const dir of dirs) pluginItems(dir, name, { source: 'plugin', category: name, plugin: id, global: enabled, enabled }, ctx, out);
      yield out.splice(0);
    }

    // Built-in agent types
    for (const [name, description] of Object.entries(BUILTIN_AGENTS)) {
      out.push({ kind: 'agent', name, path: null, source: 'builtin', category: 'builtin', description, global: true });
    }
    yield out;
  },
};
