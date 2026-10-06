// GitHub Copilot source adapter: Copilot CLI and Copilot Chat in VS Code (see adapters/index.mjs; contract
// docs/adapters-wave1.md).
//   root: COPILOT_HOME (ctx.env), else ~/.copilot
//   projects: <root>/session-state/<uuid>/workspace.yaml, only its top-level cwd: line (plain or quoted scalar;
//             the file is read in small chunks and never past that line, nothing else in it is parsed; a session
//             summary follows it); lastSeenAt: the session folder time. VS Code workspaces
//             (<APPDATA>/Code/User/workspaceStorage) that hold Copilot Chat traces (chatSessions/ or
//             chatEditingSessions/ not empty; readdir only).
//   project items: skills <p>/.github/skills, <p>/.claude/skills, <p>/.agents/skills; agents
//             <p>/.github/agents/*.agent.md (and legacy *.chatmode.md), <p>/.claude/agents/*.md
//   global items: skills <root>/skills, ~/.claude/skills (not synced), ~/.agents/skills; agents
//             <root>/agents/*.agent.md, ~/.claude/agents/*.md (personal); plugins <root>/installed-plugins
//             (plugin items only; see COPILOT_PLUGIN_LAYOUT)
import fs from 'node:fs';
import path from 'node:path';
import { exists, mtimeOf, safeDirs } from '../fsutil.mjs';
import { PERSONAL, PROJECT, cleanPath, dedupeProjects, envRoot, isPersonalClaude, listerOf, manifestText, mdAgentItems, readUntilLine, skillItems, toolPluginItems, vscodeWorkspaces } from './shared.mjs';

export const copilotHome = (ctx) => envRoot(ctx, 'COPILOT_HOME', '.copilot');
const AGENT_SUFFIXES = ['.agent.md', '.chatmode.md'];

// Value of a YAML scalar on one line: "double quoted" (JSON-style escapes), 'single quoted' ('' is a quote) or
// plain (a " #" comment is cut). null when empty.
export function yamlScalar(raw) {
  const s = String(raw).trim();
  let m = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) || null;
    } catch {
      return m[1] || null;
    }
  }
  m = /^'((?:[^']|'')*)'/.exec(s);
  if (m) return m[1].replace(/''/g, "'") || null;
  if (s.startsWith('"') || s.startsWith("'")) return null; // unterminated quote
  return s.replace(/\s+#.*$/, '').trim() || null;
}

// The working folder in a Copilot CLI workspace.yaml: the first top-level "cwd:" line only; reading stops at that
// line (readUntilLine). { cwd } (null when there is no usable cwd: line), or { error: true } when the file cannot
// be read (locked, access denied): the caller does not cache that.
const CWD_LINE = /^cwd:(.*)$/;
export function readWorkspaceYaml(file) {
  const r = readUntilLine(file, (line) => CWD_LINE.test(line));
  if (r.error) return { error: true };
  return { cwd: r.line === null ? null : cleanPath(yamlScalar(CWD_LINE.exec(r.line)[1])) };
}

// The same, as a folder or null
export function workspaceYamlCwd(file) {
  return readWorkspaceYaml(file).cwd || null;
}

// COPILOT_PLUGIN_LAYOUT: the Copilot CLI reference documents installed-plugins/<marketplace>/<plugin>/ and
// installed-plugins/_direct/<plugin>/; the inner layout of a plugin is not documented, so only the plugin itself is
// listed
function pluginDirs(root, ls) {
  const base = path.join(root, 'installed-plugins');
  const out = [];
  for (const bucket of safeDirs(base, ls)) for (const name of safeDirs(path.join(base, bucket), ls)) out.push({ dir: path.join(base, bucket, name), name });
  return out;
}

export const copilot = {
  id: 'copilot',
  name: 'GitHub Copilot',

  detect(ctx) {
    return exists(copilotHome(ctx)) || exists(path.join(ctx.appDataDir, 'Code', 'User', 'globalStorage', 'github.copilot-chat'));
  },

  findProjects(ctx) {
    const root = path.join(copilotHome(ctx), 'session-state');
    const cache = ctx.cache.sessions || (ctx.cache.sessions = new Map());
    const seen = new Set();
    const out = [];
    for (const id of safeDirs(root)) {
      const dir = path.join(root, id);
      const file = path.join(dir, 'workspace.yaml');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      seen.add(file);
      let hit = cache.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs) {
        // Cached by file time; a failed read (file locked) is not cached and is tried again on the next pass
        const r = readWorkspaceYaml(file);
        if (r.error) continue;
        hit = { mtimeMs: st.mtimeMs, cwd: r.cwd };
        cache.set(file, hit);
      }
      if (hit.cwd) out.push({ path: hit.cwd, lastSeenAt: mtimeOf(dir) });
    }
    for (const f of cache.keys()) if (!seen.has(f)) cache.delete(f);
    const vscode = ctx.cache.vscode || (ctx.cache.vscode = new Map());
    out.push(...vscodeWorkspaces(ctx.appDataDir, 'Code', { requireChat: true, cache: vscode }));
    return dedupeProjects(out);
  },

  findItems(projectPath, ctx) {
    const out = [
      ...skillItems(path.join(projectPath, '.github', 'skills'), ctx, PROJECT),
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...mdAgentItems(path.join(projectPath, '.github', 'agents'), ctx, PROJECT, { suffixes: AGENT_SUFFIXES }),
    ];
    if (!isPersonalClaude(projectPath, ctx)) {
      out.push(...skillItems(path.join(projectPath, '.claude', 'skills'), ctx, PROJECT));
      out.push(...mdAgentItems(path.join(projectPath, '.claude', 'agents'), ctx, PROJECT));
    }
    return out;
  },

  findGlobalItems(ctx) {
    const root = copilotHome(ctx);
    const claude = path.join(ctx.homeDir, '.claude');
    const out = [
      ...skillItems(path.join(root, 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(claude, 'skills'), ctx, PERSONAL, { skip: ['synced'] }),
      ...skillItems(path.join(ctx.homeDir, '.agents', 'skills'), ctx, PERSONAL),
      ...mdAgentItems(path.join(root, 'agents'), ctx, PERSONAL, { suffixes: ['.agent.md'] }),
      ...mdAgentItems(path.join(claude, 'agents'), ctx, PERSONAL),
    ];
    for (const { dir, name } of pluginDirs(root, listerOf(ctx))) {
      out.push(...toolPluginItems(dir, name, 'copilot', ctx, { description: manifestText(path.join(dir, 'plugin.json'), 'description'), skills: false }));
    }
    return out;
  },
};
