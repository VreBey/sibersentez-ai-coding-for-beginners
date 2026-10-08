// Qwen Code source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md; roadmap F4, 2026-10-08).
//   root: ~/.qwen
//   projects: ~/.qwen/projects/<folder>/chats/<uuid>.jsonl. The folder name is the working folder lower-cased with
//             its separators turned into "-", which cannot be turned back, so the working folder is the "cwd" of the
//             first line of the newest chat (readHeadCwd: the head of the file only, the cwd taken, nothing else).
//             lastSeenAt: that chat's time. One chat per project folder is opened per pass while it is unchanged.
//   project items: skills <p>/.qwen/skills; agents <p>/.qwen/agents/*.md (Qwen Code's own paths, its package 0.25)
//   global items: skills ~/.qwen/skills, agents ~/.qwen/agents/*.md (personal); extensions
//             ~/.qwen/extensions/<dir>/qwen-extension.json (plugin, with its skills/ and agents/)
import fs from 'node:fs';
import path from 'node:path';
import { exists, mtimeOf, safeDirs } from '../fsutil.mjs';
import { readHeadCwd } from './claude-code.mjs';
import { PERSONAL, PROJECT, dedupeProjects, listerOf, manifestFields, mdAgentItems, skillItems, toolPluginItems } from './shared.mjs';

const qwenDir = (ctx) => path.join(ctx.homeDir, '.qwen');

// The newest chat of a project folder: { file, mtimeMs } or null
function newestChat(chats) {
  let names;
  try {
    names = fs.readdirSync(chats);
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const f = path.join(chats, n);
    const t = mtimeOf(f);
    if (!best || t > best.mtimeMs) best = { file: f, mtimeMs: t };
  }
  return best;
}

export const qwen = {
  id: 'qwen',
  name: 'Qwen Code',

  detect(ctx) {
    const root = qwenDir(ctx);
    return ['settings.json', 'projects', 'skills', 'agents', 'extensions'].some((n) => exists(path.join(root, n)));
  },

  findProjects(ctx) {
    const root = path.join(qwenDir(ctx), 'projects');
    // The cwd of a chat file is read once while the file is unchanged (cache: file -> { mtimeMs, cwd })
    const cache = ctx.cache.qwenHeads || (ctx.cache.qwenHeads = new Map());
    const out = [];
    for (const d of safeDirs(root, listerOf(ctx))) {
      const chat = newestChat(path.join(root, d, 'chats'));
      if (!chat) continue;
      let hit = cache.get(chat.file);
      if (!hit || hit.mtimeMs !== chat.mtimeMs) {
        hit = { mtimeMs: chat.mtimeMs, cwd: readHeadCwd(chat.file) };
        cache.set(chat.file, hit);
      }
      if (typeof hit.cwd === 'string' && hit.cwd) out.push({ path: hit.cwd, lastSeenAt: chat.mtimeMs });
    }
    return dedupeProjects(out);
  },

  findItems(projectPath, ctx) {
    return [...skillItems(path.join(projectPath, '.qwen', 'skills'), ctx, PROJECT), ...mdAgentItems(path.join(projectPath, '.qwen', 'agents'), ctx, PROJECT)];
  },

  findGlobalItems(ctx) {
    const root = qwenDir(ctx);
    const out = [...skillItems(path.join(root, 'skills'), ctx, PERSONAL), ...mdAgentItems(path.join(root, 'agents'), ctx, PERSONAL)];
    const ext = path.join(root, 'extensions');
    for (const d of safeDirs(ext, listerOf(ctx))) {
      const dir = path.join(ext, d);
      const manifest = path.join(dir, 'qwen-extension.json');
      if (!exists(manifest)) continue;
      const m = manifestFields(manifest);
      out.push(...toolPluginItems(dir, m.name || d, 'qwen', ctx, { description: m.description || '', agents: true }));
    }
    return out;
  },
};
