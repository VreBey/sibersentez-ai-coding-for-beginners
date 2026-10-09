// @ts-check
// Gemini CLI source adapter (see adapters/index.mjs; contract docs/adapters-wave1.md).
//   root: ~/.gemini
//   projects: projects.json {"projects": {"<absolute path>": "<id>"}} (the keys) and the .project_root marker in
//             tmp/<id> and history/<id> (one path). Gemini may store a path lower-cased: the on-disk casing is used.
//             lastSeenAt: the newest entry time in tmp/<id>/chats (stat only, no chat is opened), else the tmp/<id>
//             folder time, else 0. Computed once per id per pass, however many sources name the id; while the chats
//             folder time is unchanged only its newest entry is looked at again (see chatsNewest).
//   project items: skills <p>/.gemini/skills, <p>/.agents/skills; agents <p>/.gemini/agents/*.md
//   global items: skills ~/.gemini/skills, ~/.agents/skills; agents ~/.gemini/agents/*.md (personal);
//             extensions ~/.gemini/extensions/<dir>/gemini-extension.json (plugin, with its skills/ and agents/)
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../util.mjs';
import { DirLister, exists, listDirs, mtimeOf, safeDirs } from '../fsutil.mjs';
import { PERSONAL, PROJECT, dedupeProjects, listerOf, manifestFields, mdAgentItems, onDiskCase, readText, skillItems, toolPluginItems } from './shared.mjs';

const geminiDir = (ctx) => path.join(ctx.homeDir, '.gemini');

// A project id is a plain folder name under tmp/ or history/ (never a path)
const safeId = (id) => typeof id === 'string' && id && !/[\\/]/.test(id) && id !== '.' && id !== '..';

// Newest entry time of a chats folder (stat only, no chat is opened), 0 when it is empty, null when it cannot be
// read. A chats folder holds thousands of session files on a busy machine, so the result is cached by the folder
// time (it changes when a session file is added or removed): while it is unchanged only the newest entry is looked
// at again (a running session appends to it). A failed listing is not cached.
function chatsNewest(chats, cache, gen) {
  let dirSt;
  try {
    dirSt = fs.statSync(chats);
  } catch {
    return null;
  }
  const hit = cache.get(chats);
  if (hit && hit.dirMtimeMs === dirSt.mtimeMs) {
    if (!hit.newest) {
      hit.gen = gen;
      return 0;
    }
    try {
      hit.newestMs = fs.statSync(hit.newest).mtimeMs;
      hit.gen = gen;
      return hit.newestMs;
    } catch {
      /* the newest entry is gone: the folder is listed again */
    }
  }
  let names;
  try {
    names = fs.readdirSync(chats);
  } catch {
    cache.delete(chats);
    return null;
  }
  let newest = null;
  let newestMs = 0;
  for (const n of names) {
    const f = path.join(chats, n);
    const t = mtimeOf(f);
    if (t > newestMs) {
      newestMs = t;
      newest = f;
    }
  }
  cache.set(chats, { dirMtimeMs: dirSt.mtimeMs, newest, newestMs, gen });
  return newestMs;
}

// Last use of a project id: newest entry of tmp/<id>/chats, else the tmp/<id> folder time, else 0
function lastSeen(root, id, cache, gen) {
  if (!safeId(id)) return 0;
  const tmp = path.join(root, 'tmp', id);
  return chatsNewest(path.join(tmp, 'chats'), cache, gen) || mtimeOf(tmp);
}

// The path in a .project_root marker (its first non-empty line), or null
function markerPath(file) {
  const text = readText(file, 8 * 1024);
  if (text === null) return null;
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}

export const geminiCli = {
  id: 'gemini-cli',
  name: 'Gemini CLI',

  detect(ctx) {
    const root = geminiDir(ctx);
    return ['projects.json', 'tmp', 'skills', 'extensions'].some((n) => exists(path.join(root, n)));
  },

  findProjects(ctx) {
    const root = geminiDir(ctx);
    const ls = ctx.ls || new DirLister();
    // One readdir per folder per pass (the lister of the pass, shared by the casing walks); one casing walk per
    // stored path and one lastSeen per id, however many sources (projects.json, two markers) name them
    const readDirs = (d) => listDirs(d, { hidden: true, ls });
    const chats = ctx.cache.chats || (ctx.cache.chats = new Map());
    const gen = (ctx.cache.gen = (ctx.cache.gen || 0) + 1);
    const cased = new Map();
    const seen = new Map();
    const out = [];
    const add = (stored, id) => {
      if (!cased.has(stored)) cased.set(stored, onDiskCase(stored, readDirs));
      const p = cased.get(stored);
      if (!p) return;
      const key = typeof id === 'string' ? id : '';
      if (!seen.has(key)) seen.set(key, lastSeen(root, id, chats, gen));
      out.push({ path: p, lastSeenAt: seen.get(key) });
    };
    const reg = readJson(path.join(root, 'projects.json'));
    const projects = reg && typeof reg === 'object' && reg.projects && typeof reg.projects === 'object' && !Array.isArray(reg.projects) ? reg.projects : {};
    for (const [stored, id] of Object.entries(projects)) add(stored, id);
    for (const sub of ['tmp', 'history']) {
      for (const id of safeDirs(path.join(root, sub), ls)) {
        const stored = markerPath(path.join(root, sub, id, '.project_root'));
        if (stored) add(stored, id);
      }
    }
    // Chats folders of ids that are gone drop out of the cache
    for (const [dir, e] of chats) if (e.gen !== gen) chats.delete(dir);
    return dedupeProjects(out);
  },

  findItems(projectPath, ctx) {
    return [
      ...skillItems(path.join(projectPath, '.gemini', 'skills'), ctx, PROJECT),
      ...skillItems(path.join(projectPath, '.agents', 'skills'), ctx, PROJECT),
      ...mdAgentItems(path.join(projectPath, '.gemini', 'agents'), ctx, PROJECT),
    ];
  },

  findGlobalItems(ctx) {
    const root = geminiDir(ctx);
    const out = [
      ...skillItems(path.join(root, 'skills'), ctx, PERSONAL),
      ...skillItems(path.join(ctx.homeDir, '.agents', 'skills'), ctx, PERSONAL),
      ...mdAgentItems(path.join(root, 'agents'), ctx, PERSONAL),
    ];
    const ext = path.join(root, 'extensions');
    for (const d of safeDirs(ext, listerOf(ctx))) {
      const dir = path.join(ext, d);
      const manifest = path.join(dir, 'gemini-extension.json');
      if (!exists(manifest)) continue; // not an extension
      const m = manifestFields(manifest); // read once for both fields
      out.push(...toolPluginItems(dir, m.name || d, 'gemini-cli', ctx, { description: m.description || '', agents: true }));
    }
    return out;
  },
};
