// @ts-check
// Cursor source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md).
//   projects: every single-folder workspace in <APPDATA>/Cursor/User/workspaceStorage (workspace.json "folder")
//   project items: skills <p>/.cursor/skills (up to 3 levels deep), <p>/.agents/skills, <p>/.claude/skills,
//             <p>/.codex/skills; agents <p>/.cursor/agents/*.md, <p>/.claude/agents/*.md
//   global items: skills ~/.cursor/skills, ~/.agents/skills, ~/.claude/skills (not synced), ~/.codex/skills (not
//             .system) (personal), ~/.cursor/skills-cursor (builtin); agents ~/.cursor/agents/*.md,
//             ~/.claude/agents/*.md (personal)
import path from 'node:path';
import { exists } from '../fsutil.mjs';
import { BUILTIN, PERSONAL, PROJECT, dedupeProjects, isPersonalClaude, mdAgentItems, skillItems, vscodeWorkspaces } from './shared.mjs';

export const cursor = {
  id: 'cursor',
  name: 'Cursor',

  detect(ctx) {
    return exists(path.join(ctx.appDataDir, 'Cursor', 'User')) || exists(path.join(ctx.homeDir, '.cursor'));
  },

  findProjects(ctx) {
    const cache = ctx.cache.vscode || (ctx.cache.vscode = new Map());
    return dedupeProjects(vscodeWorkspaces(ctx.appDataDir, 'Cursor', { cache }));
  },

  findItems(projectPath, ctx) {
    const out = [
      ...skillItems(path.join(projectPath, '.cursor', 'skills'), ctx, PROJECT, { depth: 3 }),
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...skillItems(path.join(projectPath, '.codex', 'skills'), ctx, PROJECT),
      ...mdAgentItems(path.join(projectPath, '.cursor', 'agents'), ctx, PROJECT),
    ];
    if (!isPersonalClaude(projectPath, ctx)) {
      out.push(...skillItems(path.join(projectPath, '.claude', 'skills'), ctx, PROJECT));
      out.push(...mdAgentItems(path.join(projectPath, '.claude', 'agents'), ctx, PROJECT));
    }
    return out;
  },

  findGlobalItems(ctx) {
    const home = ctx.homeDir;
    return [
      ...skillItems(path.join(home, '.cursor', 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(home, '.agents', 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(home, '.claude', 'skills'), ctx, PERSONAL, { skip: ['synced'] }),
      ...skillItems(path.join(home, '.codex', 'skills'), ctx, PERSONAL, { skip: ['.system'] }),
      ...skillItems(path.join(home, '.cursor', 'skills-cursor'), ctx, BUILTIN),
      ...mdAgentItems(path.join(home, '.cursor', 'agents'), ctx, PERSONAL),
      ...mdAgentItems(path.join(home, '.claude', 'agents'), ctx, PERSONAL),
    ];
  },
};
