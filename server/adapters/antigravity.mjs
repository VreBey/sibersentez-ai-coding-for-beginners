// @ts-check
// Antigravity source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md).
//   projects: every single-folder workspace in <APPDATA>/Antigravity IDE/User/workspaceStorage (workspace.json
//             "folder"). Antigravity CLI conversations are SQLite: not read in this wave.
//   project items: skills <p>/.agents/skills, legacy <p>/.agent/skills; agents <p>/.agents/agents/*.md and
//             <p>/.agents/agents/<name>/agent.md
//   global items: skills ~/.gemini/config/skills, legacy ~/.gemini/antigravity/skills, ~/.gemini/antigravity-cli/skills;
//             agents ~/.gemini/config/agents (personal); plugins ~/.gemini/config/plugins/<dir>,
//             ~/.gemini/antigravity-cli/plugins/<dir> (plugin, with its skills/)
import path from 'node:path';
import { exists, safeDirs } from '../fsutil.mjs';
import { PERSONAL, PROJECT, agentFolderItems, dedupeProjects, listerOf, manifestText, skillItems, toolPluginItems, vscodeWorkspaces } from './shared.mjs';

const APP = 'Antigravity IDE';

export const antigravity = {
  id: 'antigravity',
  name: 'Antigravity',

  detect(ctx) {
    const gemini = path.join(ctx.homeDir, '.gemini');
    return exists(path.join(ctx.appDataDir, APP, 'User')) || exists(path.join(gemini, 'config')) || exists(path.join(gemini, 'antigravity-cli'));
  },

  findProjects(ctx) {
    const cache = ctx.cache.vscode || (ctx.cache.vscode = new Map());
    return dedupeProjects(vscodeWorkspaces(ctx.appDataDir, APP, { cache }));
  },

  findItems(projectPath, ctx) {
    return [
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...skillItems(path.join(projectPath, '.agent', 'skills'), ctx, PROJECT),
      ...agentFolderItems(path.join(projectPath, '.agents', 'agents'), ctx, PROJECT),
    ];
  },

  findGlobalItems(ctx) {
    const gemini = path.join(ctx.homeDir, '.gemini');
    const out = [
      ...skillItems(path.join(gemini, 'config', 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(gemini, 'antigravity', 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(gemini, 'antigravity-cli', 'skills'), ctx, PERSONAL),
      ...agentFolderItems(path.join(gemini, 'config', 'agents'), ctx, PERSONAL),
    ];
    for (const base of [path.join(gemini, 'config', 'plugins'), path.join(gemini, 'antigravity-cli', 'plugins')]) {
      for (const d of safeDirs(base, listerOf(ctx))) {
        const dir = path.join(base, d);
        out.push(...toolPluginItems(dir, d, 'antigravity', ctx, { description: manifestText(path.join(dir, 'plugin.json'), 'description') }));
      }
    }
    return out;
  },
};
