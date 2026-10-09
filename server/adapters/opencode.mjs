// @ts-check
// OpenCode source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md; roadmap F4, 2026-10-08).
//   projects: none here. OpenCode keeps its projects and sessions in a SQLite database, which adapters never open
//             (contract §3); its sessions, and the folders they ran in, come from the session reader (ingest.mjs).
//   project items: skills <p>/.opencode/skill and <p>/.opencode/skills, <p>/.agents/skills; agents
//             <p>/.opencode/agent/*.md and <p>/.opencode/agents/*.md; <p>/.claude/skills (OpenCode reads it too)
//   global items: skills ~/.config/opencode/skill(s), agents ~/.config/opencode/agent(s)/*.md (personal; the folder
//             is XDG_CONFIG_HOME/opencode when that variable is set). The folder names are OpenCode's own (its
//             binary 1.18.35: .opencode/{agent,agents}, .opencode/{skill,skills}, .claude/skills, .agents/skills).
import path from 'node:path';
import { exists } from '../fsutil.mjs';
import { PERSONAL, PROJECT, isPersonalClaude, mdAgentItems, skillItems } from './shared.mjs';

const configDir = (ctx) => {
  const xdg = ctx.env?.XDG_CONFIG_HOME;
  return typeof xdg === 'string' && xdg.trim() ? path.join(xdg, 'opencode') : path.join(ctx.homeDir, '.config', 'opencode');
};

export const opencode = {
  id: 'opencode',
  name: 'OpenCode',

  detect(ctx) {
    const data = ctx.env?.XDG_DATA_HOME ? path.join(ctx.env.XDG_DATA_HOME, 'opencode') : path.join(ctx.homeDir, '.local', 'share', 'opencode');
    return exists(configDir(ctx)) || exists(data);
  },

  findProjects() {
    return [];
  },

  findItems(projectPath, ctx) {
    const oc = path.join(projectPath, '.opencode');
    const out = [
      ...skillItems(path.join(oc, 'skill'), ctx, PROJECT),
      ...skillItems(path.join(oc, 'skills'), ctx, PROJECT),
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...mdAgentItems(path.join(oc, 'agent'), ctx, PROJECT),
      ...mdAgentItems(path.join(oc, 'agents'), ctx, PROJECT),
    ];
    if (!isPersonalClaude(projectPath, ctx)) out.push(...skillItems(path.join(projectPath, '.claude', 'skills'), ctx, PROJECT));
    return out;
  },

  findGlobalItems(ctx) {
    const root = configDir(ctx);
    return [
      ...skillItems(path.join(root, 'skill'), ctx, PERSONAL),
      ...skillItems(path.join(root, 'skills'), ctx, PERSONAL),
      ...mdAgentItems(path.join(root, 'agent'), ctx, PERSONAL),
      ...mdAgentItems(path.join(root, 'agents'), ctx, PERSONAL),
    ];
  },
};
