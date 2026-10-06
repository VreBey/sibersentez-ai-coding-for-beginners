// Automatic skill fit (docs/auto-skills.md §1–§3). For one project: every skill and agent on this computer that
// could be installed into it (the candidate pool), scored against the project's tags, with a confidence band, a
// ready automatic selection and the already active items that fit. Also plans skills-apply (import, then install).
//
// Sources of the pool: the hub library, the SiberSentez kit (server/kit.mjs, installed straight from the kit folder) and
// the other projects' tool folders. One row per kind and name: the user's library first, then the kit, then the best
// project copy (docs/kit.md §6, docs/auto-skills.md §1).
//
// Read-only: nothing here writes. The census reads names only, the candidate pool reads SKILL.md and agent
// frontmatter. Nothing follows a junction or a symbolic link.
//
// Pure module: node built-ins and local modules that never import config.mjs (actions.mjs imports it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normPath, readFrontmatter, truncate } from './util.mjs';
import { isLocalPath } from './fsutil.mjs';
import { listLibrary, isLegacyHub, lstat, isRealDir, validName, hasStreamColon, proposeCategory, planImport, within, realPath, LIMITS } from './library.mjs';
import { readInstalls, isBroadFolder, resolveProject } from './install.mjs';
import { projectSignals, registrySignals, signalRoot } from './suggest.mjs';
import { readKit, kitWords, keywordHits, KIT_SOURCE } from './kit.mjs';
import { TAG_BY_ID, SIGNAL_TAGS, CATEGORY_TAGS, itemTags, ideaTags, ideaKeywords, keywordIn, words, withImplied, sortTags, primaryStacks, stacksOf, topicsOf, isStack, isFramework } from './tags.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Limits and weights (contract §2)
// ---------------------------------------------------------------------------------------------------------------

// File census: entries at most maxDepth levels below the project folder (its own entries are level 1), at most
// maxEntries entries in all (breadth first, names in byte order), at most maxManifests sub folders whose manifests
// are read
export const CENSUS = Object.freeze({ maxDepth: 3, maxEntries: 5000, maxManifests: 20 });
// Folders the census counts but never enters: the contract list (node_modules, .git, Library, Temp, obj, bin, dist,
// build, .venv), then more caches and build output of the same kind, then the AI tool folders (their scripts are
// not the project's code). Compared in lower case.
export const CENSUS_SKIP = Object.freeze(['node_modules', '.git', 'library', 'temp', 'obj', 'bin', 'dist', 'build', '.venv', 'venv', '__pycache__', 'logs', 'usersettings', '.vs', '.idea', '.gradle', '.next', '.nuxt', '.expo', '.turbo', '.cache', 'intermediate', 'binaries', 'deriveddatacache', 'saved', 'pods', 'target', 'coverage', '.claude', '.agents', '.codex', '.gemini', '.cursor', '.windsurf', '.vscode']);
const SKIP = new Set(CENSUS_SKIP);

// idea: a topic the person named in the project idea weighs as much as a stack; ideaWord: another word of the idea
// found in the item's name or description, at most IDEA_WORDS_CAP of them (docs/start-flow.md §2).
// Kit items (docs/kit.md §6): kitKeyword per word of a Turkish keyword of the item found in the idea, at most
// KIT_KEYWORDS_CAP words; emptyFolder for an item the kit offers in a folder with nothing in it yet.
export const SCORE = Object.freeze({ stack: 5, topic: 2, installedIn: 3, usedIn: 2, idea: 5, ideaWord: 1, kitKeyword: 4, emptyFolder: 8 });
export const IDEA_WORDS_CAP = 3;
export const KIT_KEYWORDS_CAP = 4;
// A kit item reaches high without a shared stack when its keywords matched at least this many words of the idea
export const KIT_HIGH_WORDS = 2;
export const HIGH_SCORE = 8;
export const MEDIUM_SCORE = 4;
// Automatic selection: every high candidate, at most this many per kind (highest score first)
export const SELECT_CAPS = Object.freeze({ skill: 4, agent: 1 });
export const MAX_REASONS = 2;
export const MAX_ACTIVE = 50;
export const MAX_EXCLUDED_SAMPLE = 20;
// Items read from one project's tool folders; places listed in a candidate's alsoIn
const MAX_PROJECT_ITEMS = 1000;
const MAX_ALSO_IN = 20;
const DESC_MAX = 400;
// Project idea (docs/start-flow.md): at most IDEA_MAX characters are read; fits of at most MAX_IDEA_FITS ideas are
// kept (all projects together, the least recently used goes first)
export const IDEA_MAX = 300;
export const MAX_IDEA_FITS = 16;
// A candidate key: kind:name (one candidate per kind and name). The older kind:name@label form (one of several
// items with the same name, before they were merged) is still accepted in a request and answered not-a-candidate.
export const KEY_RE = /^(skill|agent):([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@([A-Za-z0-9][A-Za-z0-9._-]{0,99}))?$/;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const itemKey = (kind, name) => `${kind}:${name}`.toLowerCase();

function dirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isRealFile(p) {
  const s = lstat(p);
  return !!s && s.isFile();
}

function mtimeOf(p) {
  const s = lstat(p);
  return s ? s.mtimeMs : -1;
}

function pickName(fmName, fallback) {
  const n = typeof fmName === 'string' ? fmName.trim() : '';
  return n || fallback;
}

const hash = (parts) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);

// Is a tool folder the personal Claude folder, inside it, or holding it (compared on the real paths too)
function personalFolder(p, claudeDir) {
  if (!claudeDir) return false;
  if (within(p, claudeDir) || within(claudeDir, p)) return true;
  const a = realPath(p);
  const b = realPath(claudeDir);
  return !!a && !!b && (within(a, b) || within(b, a));
}

// A project folder that may be read: listed with a path, not broad, a local drive path without a ':' after the drive
// letter; then the root as suggest.mjs reads it (a junction root is followed one hop). null: nothing is read.
function readableRoot(p, { broad, homeDir }) {
  if (!p?.path || p.broad || p.tmpOnly || !isLocalPath(p.path) || hasStreamColon(p.path)) return null;
  if (broad(p.path) || isBroadFolder(p.path, homeDir)) return null;
  return signalRoot(p.path, { broad });
}

// ---------------------------------------------------------------------------------------------------------------
// File census (contract §2.1)
// ---------------------------------------------------------------------------------------------------------------

// Reads names only, breadth first: the project folder, then its folders level by level, each in byte order, until
// maxEntries entries were seen. A link (junction, symbolic link) is counted and never followed; a folder in
// CENSUS_SKIP is counted and not entered. Returns { entries, truncated, exts: Map(ext -> { count, first }),
// files: [{ name, rel }], dirs: [{ name, rel }], unityRoots: [rel], manifestDirs: [{ abs, rel }], folders: [{ abs,
// mtimeMs }] } (names in lower case; rel '/' separated; folders: every folder listed, for the cache fingerprint).
export function census(root, { maxDepth = CENSUS.maxDepth, maxEntries = CENSUS.maxEntries, maxManifests = CENSUS.maxManifests } = {}) {
  const out = { entries: 0, truncated: false, exts: new Map(), files: [], dirs: [], unityRoots: [], manifestDirs: [], folders: [] };
  if (!root || !isRealDir(root)) return out;
  const queue = [{ abs: root, rel: '', depth: 0 }];
  while (queue.length && !out.truncated) {
    const { abs, rel, depth } = queue.shift();
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true }).sort(byName);
    } catch {
      continue;
    }
    out.folders.push({ abs, mtimeMs: mtimeOf(abs) });
    const childDirs = new Set();
    let manifest = false;
    for (const d of ents) {
      if (out.entries >= maxEntries) {
        out.truncated = true;
        break;
      }
      out.entries++;
      const lower = d.name.toLowerCase();
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        childDirs.add(lower);
        out.dirs.push({ name: lower, rel: r });
        if (depth + 1 < maxDepth && !SKIP.has(lower)) queue.push({ abs: path.join(abs, d.name), rel: r, depth: depth + 1 });
      } else if (d.isFile()) {
        out.files.push({ name: lower, rel: r });
        const ext = path.extname(lower);
        if (ext) {
          const e = out.exts.get(ext);
          if (e) e.count++;
          else out.exts.set(ext, { count: 1, first: r });
        }
        if (MANIFEST_FILES.has(lower) || /\.(csproj|sln|uproject)$/.test(lower)) manifest = true;
      }
    }
    const unity = childDirs.has('assets') && childDirs.has('projectsettings');
    if (unity) out.unityRoots.push(rel);
    // The project folder's own manifests are read by projectSignals already
    if ((manifest || unity) && rel && out.manifestDirs.length < maxManifests) out.manifestDirs.push({ abs, rel });
  }
  return out;
}

const MANIFEST_FILES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'pubspec.yaml', 'project.godot', 'dockerfile']);

// File extensions -> tags; min: how many files it takes
export const EXT_RULES = Object.freeze([
  { exts: ['.unity', '.prefab', '.asmdef', '.uxml', '.uss'], tags: ['unity'], min: 1 },
  { exts: ['.meta'], tags: ['unity'], min: 10 },
  { exts: ['.uproject', '.uplugin', '.uasset', '.umap'], tags: ['unreal'], min: 1 },
  { exts: ['.gd'], tags: ['godot', 'gdscript'], min: 1 },
  { exts: ['.tscn', '.gdshader'], tags: ['godot'], min: 1 },
  { exts: ['.csproj', '.sln', '.slnx'], tags: ['csharp'], min: 1 },
  { exts: ['.cs'], tags: ['csharp'], min: 3 },
  { exts: ['.razor', '.cshtml', '.xaml'], tags: ['dotnet', 'csharp'], min: 1 },
  { exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'], tags: ['cpp'], min: 3 },
  { exts: ['.tsx'], tags: ['react', 'typescript'], min: 3 },
  { exts: ['.jsx'], tags: ['react', 'javascript'], min: 3 },
  { exts: ['.ts', '.mts', '.cts'], tags: ['typescript'], min: 3 },
  { exts: ['.js', '.mjs', '.cjs'], tags: ['javascript'], min: 3 },
  { exts: ['.vue'], tags: ['vue'], min: 1 },
  { exts: ['.svelte'], tags: ['svelte'], min: 1 },
  { exts: ['.py'], tags: ['python'], min: 3 },
  { exts: ['.ipynb'], tags: ['python', 'data'], min: 1 },
  { exts: ['.go'], tags: ['go'], min: 3 },
  { exts: ['.rs'], tags: ['rust'], min: 3 },
  { exts: ['.java'], tags: ['java'], min: 3 },
  { exts: ['.kt', '.kts'], tags: ['kotlin'], min: 3 },
  { exts: ['.swift'], tags: ['swift'], min: 3 },
  { exts: ['.dart'], tags: ['dart'], min: 3 },
  { exts: ['.php'], tags: ['php'], min: 3 },
  { exts: ['.rb'], tags: ['ruby'], min: 3 },
  { exts: ['.lua'], tags: ['lua'], min: 3 },
  { exts: ['.shader', '.hlsl', '.glsl', '.cginc', '.compute', '.shadergraph', '.shadersubgraph', '.vfx'], tags: ['graphics'], min: 1 },
  { exts: ['.wav', '.ogg', '.mp3', '.flac', '.aif', '.aiff', '.bank'], tags: ['audio'], min: 3 },
  { exts: ['.sql', '.prisma'], tags: ['database'], min: 1 },
  { exts: ['.tf'], tags: ['devops'], min: 1 },
  { exts: ['.po', '.pot', '.xliff', '.xlf'], tags: ['localization'], min: 1 },
  { exts: ['.html', '.htm'], tags: ['web'], min: 3 },
  { exts: ['.css', '.scss', '.sass', '.less'], tags: ['web'], min: 3 },
  { exts: ['.fig', '.sketch'], tags: ['design'], min: 1 },
]);

// File names -> tags (exact lower-case names or patterns)
export const FILE_RULES = Object.freeze([
  { names: ['project.godot'], tags: ['godot'] },
  { names: ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml'], tags: ['devops'] },
  { names: ['tsconfig.json'], tags: ['typescript'] },
  { names: ['appsettings.json'], tags: ['dotnet'] },
  { names: ['mkdocs.yml'], tags: ['docs'] },
  { names: ['security.md'], tags: ['security'] },
  { names: ['pubspec.yaml'], tags: ['flutter'] },
  { names: ['go.mod'], tags: ['go'] },
  { names: ['cargo.toml'], tags: ['rust'] },
  { re: /\.(?:test|spec)\.[a-z0-9]+$|^test_.+\.py$|_test\.(?:go|py)$|tests?\.cs$|\.tests?(?:\.[a-z0-9]+)*\.csproj$/, tags: ['testing'] },
]);

// Folder names -> tags (exact lower-case names or patterns)
export const DIR_RULES = Object.freeze([
  { names: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing', 'editmode', 'playmode'], tags: ['testing'] },
  { names: ['docs', 'documentation'], tags: ['docs'] },
  { names: ['design'], tags: ['design'] },
  { names: ['gdd'], tags: ['gamedev'] },
  { names: ['production', 'sprints', 'milestones'], tags: ['planning'] },
  { names: ['migrations', 'prisma'], tags: ['database'] },
  { names: ['locales', 'locale', 'i18n', 'l10n', 'translations', 'localization', 'localisation'], tags: ['localization'] },
  { names: ['audio', 'sounds', 'sound', 'sfx', 'music'], tags: ['audio'] },
  { names: ['shaders'], tags: ['graphics'] },
  { names: ['android', 'ios'], tags: ['mobile'] },
  { names: ['terraform', 'k8s', 'helm'], tags: ['devops'] },
  { names: ['notebooks'], tags: ['data'] },
  // A book, a webtoon or a script: the Building seats its team in the library (2026-10-01, a novel project had no tags)
  { names: ['chapters', 'manuscript', 'manuscripts', 'novel', 'screenplay', 'storyboard', 'storyboards', 'bolumler', 'bölümler'], tags: ['content'] },
  { re: /netcode|multiplayer/, tags: ['multiplayer'] },
]);

// Tags of a census: Map(tag -> from), where from names the evidence ('Assets/, ProjectSettings/', '*.cs x12',
// 'docs/'). Deterministic: rules in table order, evidence in census order.
export function censusTags(c) {
  const out = new Map();
  const add = (tags, from) => {
    for (const t of tags) if (TAG_BY_ID.has(t) && !out.has(t)) out.set(t, from);
  };
  for (const rel of c.unityRoots) add(['unity', 'csharp'], rel ? `${rel}/Assets, ProjectSettings` : 'Assets/, ProjectSettings/');
  for (const r of EXT_RULES) {
    let count = 0;
    for (const e of r.exts) count += c.exts.get(e)?.count || 0;
    if (count >= r.min) add(r.tags, `${r.exts[0].replace('.', '*.')} x${count}`);
  }
  for (const f of c.files) for (const r of FILE_RULES) if (r.names ? r.names.includes(f.name) : r.re.test(f.name)) add(r.tags, f.rel);
  for (const d of c.dirs) {
    if (d.rel.endsWith('.github/workflows') && (d.rel === '.github/workflows' || d.rel.endsWith('/.github/workflows'))) add(['devops'], `${d.rel}/`);
    for (const r of DIR_RULES) if (r.names ? r.names.includes(d.name) : r.re.test(d.name)) add(r.tags, `${d.rel}/`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Project profile
// ---------------------------------------------------------------------------------------------------------------

// Tags of a project: registry packages (registered projects), the manifest signals of its folder (suggest.mjs), the
// census and the manifest signals of the sub folders the census found (a Unity project in a sub folder, a monorepo
// app), then the tags those imply. Returns { tags: Map(tag -> from), stacks, primary, topics (Sets), entries,
// truncated, folders (for the fingerprint), root }.
export function projectProfile(p, { broad = () => false, homeDir = null } = {}) {
  const tags = new Map();
  const add = (list, from) => {
    for (const t of list || []) if (TAG_BY_ID.has(t) && !tags.has(t)) tags.set(t, from);
  };
  if (p?.kind === 'registered') {
    for (const s of registrySignals(p.packages, new Set(Object.keys(CATEGORY_TAGS)))) add([CATEGORY_TAGS[s.id]], 'registry');
  }
  const root = readableRoot(p, { broad, homeDir });
  let c = { entries: 0, truncated: false, folders: [] };
  if (root) {
    for (const s of projectSignals(root, { broad })) add(SIGNAL_TAGS[s.id], s.from);
    c = census(root);
    for (const [t, from] of censusTags(c)) add([t], from);
    for (const m of c.manifestDirs) for (const s of projectSignals(m.abs, { broad })) add(SIGNAL_TAGS[s.id], `${m.rel}/${s.from}`);
  }
  for (const [t, from] of [...tags]) for (const x of withImplied([t])) add([x], from);
  const ids = new Set(tags.keys());
  // The fingerprint: every folder the census listed, plus the tool folders (the census does not enter them, but an
  // item added or removed there changes what the project already has)
  const tools = root ? TOOL_FOLDERS.map((rel) => path.join(root, rel)).map((abs) => ({ abs, mtimeMs: mtimeOf(abs) })) : [];
  // The project folder itself, even when it is gone (-1): a folder that comes back (or goes) changes the fingerprint;
  // before, a missing folder left an empty one that never changed, and the fit said "folder missing" for ever
  const self = typeof p?.path === 'string' && p.path ? [{ abs: p.path, mtimeMs: mtimeOf(p.path) }] : [];
  return { tags, stacks: stacksOf(ids), primary: primaryStacks(ids), topics: topicsOf(ids), entries: c.entries, truncated: c.truncated, folders: [...self, ...c.folders, ...tools], root };
}

const TOOL_FOLDERS = Object.freeze(['.claude', path.join('.claude', 'skills'), path.join('.claude', 'agents'), '.agents', path.join('.agents', 'skills')]);

// The census folders still have the modification times they had: nothing was added, removed or renamed in them
function foldersUnchanged(folders) {
  for (const f of folders) if (mtimeOf(f.abs) !== f.mtimeMs) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Project items (the tool folders of a project)
// ---------------------------------------------------------------------------------------------------------------

const TOOL_GROUPS = Object.freeze([
  ['.claude', 'skills', 'skill', 'claude'],
  ['.claude', 'agents', 'agent', 'claude'],
  ['.agents', 'skills', 'skill', 'agents'],
]);

// Skills and agents in a project's tool folders: .claude/skills/<x>/SKILL.md, .claude/agents/<x>.md,
// .agents/skills/<x>/SKILL.md. Frontmatter only. A tool folder that is a link, or is (or holds) the personal Claude
// folder, is not read; links inside are skipped. One item per kind and name (the .claude copy first).
// Returns [{ kind, name, description, path, target }].
export function readProjectItems(dir, { claudeDir = null, frontmatter = readFrontmatter, max = MAX_PROJECT_ITEMS } = {}) {
  const out = [];
  const seen = new Set();
  if (!dir) return out;
  for (const [tool, group, kind, target] of TOOL_GROUPS) {
    const base = path.join(dir, tool);
    if (!isRealDir(base) || personalFolder(base, claudeDir)) continue;
    const g = path.join(base, group);
    if (!isRealDir(g)) continue;
    for (const d of dirents(g).sort(byName)) {
      if (out.length >= max) return out;
      if (d.name.startsWith('.')) continue;
      let item = null;
      if (kind === 'skill') {
        if (!d.isDirectory()) continue;
        const md = path.join(g, d.name, 'SKILL.md');
        if (!isRealFile(md)) continue;
        const meta = frontmatter(md) || {};
        item = { kind, name: pickName(meta.name, d.name), description: truncate(meta.description, DESC_MAX), path: path.join(g, d.name), target };
      } else {
        if (!d.isFile() || !/\.md$/i.test(d.name) || /^readme\.md$/i.test(d.name)) continue;
        const file = path.join(g, d.name);
        const meta = frontmatter(file) || {};
        item = { kind, name: pickName(meta.name, d.name.replace(/\.md$/i, '')), description: truncate(meta.description, DESC_MAX), path: file, target };
      }
      const k = itemKey(item.kind, item.name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Project idea (docs/start-flow.md): what the person wants to build, typed in the drawer
// ---------------------------------------------------------------------------------------------------------------

// Characters that never belong in an idea: C0 and C1 controls (a newline or a tab becomes a space), zero-width and
// direction marks and overrides, the byte order mark
const IDEA_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const IDEA_INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// The idea as the fit reads it: a string, controls and invisible marks out, spaces collapsed, at most IDEA_MAX
// characters (code points), trimmed. Anything else (not a string, only spaces) is ''. The idea is never written to a
// file or a log line; it is kept in memory as a cache key only (MAX_IDEA_FITS).
export function normalizeIdea(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  // A long input is cut first, so no work depends on its length
  let s = raw.slice(0, IDEA_MAX * 4);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  s = s.normalize('NFC').replace(IDEA_CONTROL_RE, ' ').replace(IDEA_INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, IDEA_MAX).join('').trim();
}

// A project profile with the tags of an idea (ideaTags) added: the idea's stack tags join the stacks (so the conflict
// rule and the primary stack follow the idea too), its topics join the topics. idea: Map(tag -> { via, named }) where
// named says the text names the tag (it then weighs SCORE.idea) and via is the named tag a reason points to.
// keywords: the idea's other words (ideaKeywords), kept as ideaWords. No idea: the profile itself.
export function withIdea(profile, list, keywords = []) {
  const tags = Array.isArray(list) ? list : [];
  const kw = Array.isArray(keywords) ? keywords : [];
  if (!tags.length && !kw.length) return profile;
  const ids = new Set([...profile.tags.keys(), ...tags.map((x) => x.id)]);
  const idea = new Map(tags.map((x) => [x.id, { via: x.via || x.id, named: !x.via }]));
  return { ...profile, stacks: stacksOf(ids), primary: primaryStacks(ids), topics: topicsOf(ids), idea, ideaWords: kw };
}

// The lower-case words of an item's name and description (for the idea's other words)
export function itemWords({ name = '', description = '' } = {}) {
  return new Set(words(`${String(name).replace(/[-_.:/]+/g, ' ')} ${description || ''}`).map((x) => x.w));
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring (contract §2.3–§2.5)
// ---------------------------------------------------------------------------------------------------------------

const NO_IDEA = new Map();

// Score of one item against a project profile. tags: the item's tags. others: [{ id, primary }] profiles of the
// other projects the item is installed in (installedIn) or was used in (usedIn), sorted by id.
// A profile with an idea (withIdea): a topic the idea names weighs SCORE.idea instead of SCORE.topic, and a shared tag
// that only the idea gives (not the project's files) has the reason idea:<the named tag>. The idea's other words
// (profile.ideaWords) found in the item's words (itemWords) add SCORE.ideaWord each, at most IDEA_WORDS_CAP, only to an
// item that fits already (score above zero), with the reason idea-word:<the word as typed>.
// Returns { excluded, stacks (the item's primary stacks), score, confidence, reasons }.
export function scoreItem(tags, profile, opts = {}) {
  const p = scoreParts(tags, profile, opts);
  if (p.excluded) return { excluded: true, stacks: p.stacks, score: 0, confidence: 'low', reasons: [] };
  return { excluded: false, stacks: p.stacks, score: p.score, confidence: band(p.score, p.primaryShared), reasons: [...new Set([...p.stackReasons, ...p.otherReasons])].slice(0, MAX_REASONS) };
}

// Confidence of a score: high needs a shared primary stack (or, for a kit item, the evidence scoreKitItem accepts)
const band = (score, strong) => (strong && score >= HIGH_SCORE ? 'high' : score >= MEDIUM_SCORE ? 'medium' : 'low');

// The parts of scoreItem: { excluded, stacks, score, primaryShared (a shared primary stack), stackReasons (shared
// stacks, strongest first), otherReasons (the idea's words, topics the idea names, installed in, used in, topics) }
function scoreParts(tags, profile, { installedIn = [], usedIn = [], words: itemWordSet = null } = {}) {
  const item = new Set(tags);
  const stacks = primaryStacks(item);
  let shared = [...stacks].filter((t) => profile.stacks.has(t));
  if (stacks.size && !shared.length) {
    // A language named without a framework (an idea such as "Python ile API", a folder of plain .py files) agrees with an
    // item built on a framework of that language; a project on another framework of it (Django and a FastAPI item) does not
    const own = [...profile.stacks].some(isFramework);
    shared = own ? [] : [...stacksOf(item)].filter((t) => !isFramework(t) && profile.stacks.has(t));
    if (!shared.length) return { excluded: true, stacks: [...stacks] };
  }
  const idea = profile.idea instanceof Map ? profile.idea : NO_IDEA;
  const named = (t) => !!idea.get(t)?.named;
  const topics = [...topicsOf(item)].filter((t) => profile.topics.has(t));
  const sharesStack = (q) => [...q.primary].some((t) => profile.primary.has(t));
  const inst = installedIn.find(sharesStack) || null;
  const used = usedIn.find(sharesStack) || null;
  const topicScore = topics.reduce((sum, t) => sum + (named(t) ? SCORE.idea : SCORE.topic), 0);
  const base = SCORE.stack * shared.length + topicScore + (inst ? SCORE.installedIn : 0) + (used ? SCORE.usedIn : 0);
  const kw = Array.isArray(profile.ideaWords) && itemWordSet instanceof Set && base > 0 ? profile.ideaWords.filter((k) => keywordIn(k.w, itemWordSet)).slice(0, IDEA_WORDS_CAP) : [];
  const score = base + SCORE.ideaWord * kw.length;
  const primaryShared = shared.filter((t) => profile.primary.has(t));
  // A tag the project's files show keeps its own reason; one only the idea gives points to the idea
  const fileTags = profile.tags instanceof Map ? profile.tags : NO_IDEA;
  const reason = (t, kind) => (idea.has(t) && !fileTags.has(t) ? `idea:${idea.get(t).via}` : `${kind}:${t}`);
  // Strongest first: shared primary stacks, other shared stacks, then the idea's other words (they tell apart items that
  // share the rest), topics the idea names, installed in, used in, topics
  const stackReasons = [...sortTags(primaryShared).map((t) => reason(t, 'stack')), ...sortTags(shared.filter((t) => !profile.primary.has(t))).map((t) => reason(t, 'stack'))];
  const otherReasons = [
    ...kw.map((k) => `idea-word:${k.raw}`),
    ...sortTags(topics.filter(named)).map((t) => reason(t, 'topic')),
    ...(inst ? [`installed-in:${inst.id}`] : []),
    ...(used ? [`used-in:${used.id}`] : []),
    ...sortTags(topics.filter((t) => !named(t))).map((t) => reason(t, 'topic')),
  ];
  return { excluded: false, stacks: [...stacks], score, primaryShared: primaryShared.length > 0, stackReasons, otherReasons };
}

// Score of a kit item (docs/kit.md §6). kit: the kit item (tags, stage, keywords, offer). ctx: { ws (kitWords of the
// idea), wordOf (reason -> the idea's words it shows, to drop a second reason that shows the same words), fresh (the
// folder has no tag at all: nothing in it yet), code (the folder shows a stack: it has code) }.
//   - Tags: the kit's own sibersentez-tags and what they imply (curated: a word in a description never adds a topic).
//   - Stack conflict: as for every item, but in a folder whose profile has no stack (none in the files, none in the
//     idea) nothing is excluded: the keywords decide ("Telegram botu" reaches the Python bot starter).
//   - Keywords: SCORE.kitKeyword per word of a keyword found in the idea (a phrase counts its words), at most
//     KIT_KEYWORDS_CAP words; the reason is idea-word:<the words as typed>. The idea's other words (ideaKeywords) do
//     not count again for a kit item.
//   - An empty folder: an item offered there (sibersentez-offer: empty-folder) gets SCORE.emptyFolder, idea or not.
//   - High: as for every item (a shared primary stack and HIGH_SCORE), or HIGH_SCORE with the offer or with keywords
//     matching at least KIT_HIGH_WORDS words.
//   - A folder with code: a start item (a step of a new project) is never selected by itself: at most medium when
//     the idea's keywords asked for it, else at most low (a starter is no news in a project that already runs).
// Returns scoreItem's shape.
export function scoreKitItem(kit, profile, { ws = [], wordOf = () => null, fresh = false, code = false, installedIn = [], usedIn = [] } = {}) {
  const all = sortTags(withImplied(kit.tags || []));
  const tags = profile.stacks.size ? all : all.filter((t) => !isStack(t));
  const p = scoreParts(tags, profile, { installedIn, usedIn });
  if (p.excluded) return { excluded: true, stacks: p.stacks, score: 0, confidence: 'low', reasons: [] };
  // Longest keyword first: its words are the reason, a shorter keyword inside them adds points but no reason
  const hits = keywordHits(kit.keywords, ws).sort((a, b) => b.count - a.count);
  const kwWords = hits.reduce((n, h) => n + h.count, 0);
  const offer = fresh && (kit.offer || []).includes('empty-folder');
  const score = p.score + SCORE.kitKeyword * Math.min(kwWords, KIT_KEYWORDS_CAP) + (offer ? SCORE.emptyFolder : 0);
  let confidence = band(score, p.primaryShared || offer || kwWords >= KIT_HIGH_WORDS);
  if (code && kit.stage === 'start') {
    const cap = kwWords ? 'medium' : 'low';
    if (BAND[confidence] < BAND[cap]) confidence = cap;
  }
  // Reasons, strongest first: shared stacks, the empty folder, the keywords, the rest; a reason whose words another
  // reason already shows is left out
  const out = [];
  const shown = new Set();
  for (const r of [...p.stackReasons, ...(offer ? ['empty-folder'] : []), ...hits.map((h) => `idea-word:${h.raw}`), ...p.otherReasons]) {
    const parts = wordOf(r) || [];
    if (out.includes(r) || (parts.length && parts.every((x) => shown.has(x)))) continue;
    for (const x of parts) shown.add(x);
    out.push(r);
  }
  return { excluded: false, stacks: p.stacks, score, confidence, reasons: out.slice(0, MAX_REASONS) };
}

// What the kit scoring needs from a project (its profile without the idea) and an idea (the text and its ideaTags):
// { ws: the idea's words (kit.mjs kitWords), wordOf(reason): the folded words a reason shows ('idea:<tag>' the words
// that named the tag, 'idea-word:<words>' those words, anything else null), fresh: the folder shows no tag at all
// (nothing in it yet), code: it shows a stack tag (files or registry) }
export function kitContext(base, idea = '', list = []) {
  const ws = idea ? kitWords(idea) : [];
  const folded = (text) => kitWords(text).map((x) => x.w);
  const named = new Map();
  for (const x of list) if (x.word && !x.via) named.set(x.id, folded(x.word));
  const wordOf = (r) => {
    const s = String(r);
    const i = s.indexOf(':');
    if (i <= 0) return null;
    const kind = s.slice(0, i);
    const arg = s.slice(i + 1);
    if (kind === 'idea') return named.get(arg) || null;
    if (kind === 'idea-word') return folded(arg);
    return null;
  };
  const tags = base?.tags instanceof Map ? [...base.tags.keys()] : [];
  return { ws, wordOf, fresh: tags.length === 0, code: stacksOf(tags).size > 0 };
}

const BAND = { high: 0, medium: 1, low: 2 };
const kindRank = (k) => (k === 'skill' ? 0 : 1);
// Candidate order: confidence band, score (high first), skills before agents, name, key (byte order)
export function byFit(a, b) {
  return BAND[a.confidence] - BAND[b.confidence] || b.score - a.score || kindRank(a.kind) - kindRank(b.kind) || cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.key, b.key);
}

// Automatic selection: installable, not installed, high, from the SiberSentez kit or the library (an item found only in
// another project waits behind the drawer's "also from my other projects", docs/direction.md §3.2, so it is never
// chosen unseen); one per kind and name; at most caps per kind, in byFit order. Returns a Set of keys.
export function autoSelect(candidates, caps = SELECT_CAPS) {
  const out = new Set();
  const taken = new Set();
  const count = { skill: 0, agent: 0 };
  // One starter at most: a beginner starts one way (the best fit); project-setup readies the folder, not a stack, and
  // goes with any of them. The others stay in the list, not selected.
  let starter = false;
  const isStarter = (c) => c.category === 'starters' && c.name !== 'project-setup';
  const own = (c) => Array.isArray(c.sources) && (c.sources.includes('kit') || c.sources.includes('library'));
  for (const c of [...candidates].sort(byFit)) {
    if (!c.installable || c.installed || c.confidence !== 'high' || !own(c)) continue;
    const k = itemKey(c.kind, c.name);
    if (taken.has(k) || count[c.kind] >= (caps[c.kind] ?? 0)) continue;
    if (isStarter(c) && starter) continue;
    if (isStarter(c)) starter = true;
    taken.add(k);
    count[c.kind]++;
    out.add(c.key);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Candidate pool (contract §1)
// ---------------------------------------------------------------------------------------------------------------

// The occurrence a row of the pool installs from, when several places hold an item of the same kind and name (even
// with other content: one row per name, docs/kit.md §6): the user's library, else the SiberSentez kit, else the best
// project copy (one in a project where the item was used, then the most recently changed, then the project id in
// byte order). usedIn: Set of the project ids the item was used in.
export function chooseOccurrence(occ, usedIn = new Set()) {
  const lib = occ.find((o) => o.source === 'library');
  if (lib) return lib;
  const kit = occ.find((o) => o.source === KIT_SOURCE);
  if (kit) return kit;
  const main = (o) => (o.kind === 'skill' ? path.join(o.path, 'SKILL.md') : o.path);
  const ranked = occ.map((o) => ({ o, used: usedIn.has(o.projectId) ? 1 : 0, mtime: mtimeOf(main(o)) }));
  ranked.sort((a, b) => b.used - a.used || b.mtime - a.mtime || cmp(String(a.o.projectId), String(b.o.projectId)));
  return ranked[0].o;
}

// Where an occurrence sits, as candidates name it: 'library', 'kit' or 'project:<id>'
const placeOf = (o) => (o.source === 'project' ? `project:${o.projectId}` : o.source);

// ---------------------------------------------------------------------------------------------------------------
// The fit service: computation and cache (contract §3)
// ---------------------------------------------------------------------------------------------------------------

// catalog: the catalog (getProject, allProjects, roster, isBroad, frontmatter, version). ingest: usage from the logs
// (ingest.usage.skills / agents: name -> { projects: Set }). hubDir, homeDir, claudeDir and kitDir (the SiberSentez kit
// folder, server/kit.mjs) default to the catalog's; a catalog without kitDir has no kit.
// How long the library's signature is trusted (docs/backlog.md "Long-running load": every /fit used to lstat the
// whole library); an install or an import calls invalidate(), which forgets it at once
export const LIBRARY_SIG_MS = 5000;

export function createFit({ catalog, ingest = null, hubDir, homeDir, claudeDir, kitDir, limits = LIMITS, now = Date.now } = {}) {
  const hub = hubDir !== undefined ? hubDir : catalog?.hubDir ?? null;
  const home = homeDir !== undefined ? homeDir : catalog?.homeDir ?? null;
  const personal = claudeDir !== undefined ? claudeDir : catalog?.claudeDir ?? null;
  const kitRoot = kitDir !== undefined ? kitDir || null : catalog?.kitDir ?? null;
  const pools = new Map(); // project id -> { sig, profile, pool, active, problem, byKey, plain (the fit without an idea) }
  const ideaFits = new Map(); // `${project id}\n${idea}` -> { entry (the pool it was scored from), fit }
  const profiles = new Map(); // project id -> { key, profile }
  let rosterSig = { roster: null, version: undefined, sig: '' };
  // computed: pools built; scored: fits of ideas scored from a kept pool; cached: answers from the cache
  const stats = { computed: 0, cached: 0, scored: 0 };

  const broad = (dir) => typeof catalog?.isBroad === 'function' && !!catalog.isBroad(normPath(dir));
  const frontmatter = typeof catalog?.frontmatter === 'function' ? (f) => catalog.frontmatter(f) : readFrontmatter;
  const allProjects = () => (typeof catalog?.allProjects === 'function' ? catalog.allProjects() : []);
  const roster = () => (catalog?.roster instanceof Map ? catalog.roster : new Map());

  // Profile of a project, kept while its folder, its census folders and its registry packages stay the same
  function profileOf(p) {
    const key = JSON.stringify([p.path || '', p.kind, p.kind === 'registered' ? p.packages || [] : [], !!p.broad, !!p.tmpOnly]);
    const hit = profiles.get(p.id);
    if (hit && hit.key === key && foldersUnchanged(hit.profile.folders)) return hit.profile;
    const profile = projectProfile(p, { broad, homeDir: home });
    profiles.set(p.id, { key, profile });
    return profile;
  }

  // Signatures of what a fit depends on besides the project folder
  function currentRosterSig() {
    const r = roster();
    if (rosterSig.roster === r && rosterSig.version === catalog?.version && catalog?.version !== undefined) return rosterSig.sig;
    const parts = [];
    for (const [k, it] of r) parts.push(`${k}|${(it.sources || [it.source]).join(',')}|${(it.installedIn || []).join(',')}|${it.global ? 1 : 0}|${it.enabled ? 1 : 0}|${it.description || ''}`);
    for (const p of allProjects()) parts.push(`p|${p.id}|${p.path || ''}|${p.kind}|${p.broad ? 1 : 0}`);
    rosterSig = { roster: r, version: catalog?.version, sig: hash(parts) };
    return rosterSig.sig;
  }
  let libSigCache = null;
  function librarySig() {
    if (libSigCache && now() - libSigCache.at < LIBRARY_SIG_MS) return libSigCache.sig;
    const sig = readLibrarySig();
    libSigCache = { at: now(), sig };
    return sig;
  }
  function readLibrarySig() {
    if (!hub || isLegacyHub(hub)) return 'none';
    const parts = [];
    for (const it of listLibrary(hub, { frontmatter })) {
      const main = it.kind === 'skill' ? path.join(it.path, 'SKILL.md') : it.path;
      const st = lstat(main);
      parts.push(`${it.kind}|${it.name}|${it.category}|${it.rel}|${st ? `${st.mtimeMs}:${st.size}` : '-'}|${mtimeOf(it.path)}`);
    }
    parts.push(`installs|${mtimeOf(path.join(hub, 'registry', 'installs.json'))}`);
    return hash(parts);
  }
  // The kit is read through its own cache (kit.mjs): the same object while no kit file changed
  let kitSeen = { kit: null, n: 0 };
  function kitNow() {
    const kit = readKit(kitRoot, { frontmatter });
    if (kit !== kitSeen.kit) kitSeen = { kit, n: kitSeen.n + 1 };
    return kitSeen;
  }
  function usageSig() {
    const parts = [];
    for (const kind of ['skills', 'agents']) {
      const m = ingest?.usage?.[kind];
      if (!(m instanceof Map)) continue;
      for (const [name, u] of m) parts.push(`${kind}|${name}|${[...(u?.projects || [])].sort().join(',')}`);
    }
    return hash(parts.sort());
  }

  // Projects an item was used in (logs), by kind and lower-case name: Map(kind -> Map(name -> Set(project id)))
  function usageIndex() {
    const out = new Map([['skill', new Map()], ['agent', new Map()]]);
    for (const [kind, key] of [['skill', 'skills'], ['agent', 'agents']]) {
      const m = ingest?.usage?.[key];
      if (!(m instanceof Map)) continue;
      const idx = out.get(kind);
      for (const [name, u] of m) {
        const lc = String(name).toLowerCase();
        if (!idx.has(lc)) idx.set(lc, new Set());
        for (const id of u?.projects || []) idx.get(lc).add(id);
      }
    }
    return out;
  }

  // The candidate pool of a project: every item that could be installed into it with its tags, sources and whether it
  // can be installed, and the already active items, before any scoring. It does not depend on an idea, so one pool
  // serves every idea (and skills-apply finds any key of it, whatever idea chose it). Holds internal fields (paths).
  function buildPool(p) {
    const profile = profileOf(p);
    // Why nothing can be installed into this project (the codes skills-apply answers with), or null
    let problem = !hub ? 'no-hub' : isLegacyHub(hub) ? 'legacy-hub' : null;
    if (!problem) {
      const rp = resolveProject({ catalog, projectId: p.id, hubDir: hub, homeDir: home, claudeDir: personal });
      if (!rp.ok) problem = rp.error;
    }
    const pRoot = profile.root;
    const r = roster();
    const usage = usageIndex();
    const usedInOf = (kind, name) => [...(usage.get(kind)?.get(name.toLowerCase()) || [])].filter((id) => id !== p.id).sort();

    // What the project already has, by kind and name (any target): its tool folders, SiberSentez's record, the roster
    const own = new Set();
    if (pRoot) for (const it of readProjectItems(pRoot, { claudeDir: personal, frontmatter })) own.add(itemKey(it.kind, it.name));
    // A record whose folder is gone (the person deleted .claude) does not count: Start sets that item up again
    if (hub && !problem) for (const rec of readInstalls(hub).installs) if (rec.project === p.id && typeof rec.path === 'string' && fs.existsSync(rec.path)) own.add(itemKey(rec.kind, rec.name));
    for (const [k, it] of r) if ((it.kind === 'skill' || it.kind === 'agent') && (it.installedIn || []).includes(p.id)) own.add(k);

    // Occurrences: the library, the kit, then the other listed projects (by id); one per place per kind and name
    const occurrences = [];
    // A legacy hub's library is its catalog only (nothing there can be installed); without a hub there is none
    const library = hub && !isLegacyHub(hub) ? listLibrary(hub, { frontmatter }) : [];
    for (const it of library) {
      if (!validName(it.name)) continue;
      occurrences.push({ source: 'library', kind: it.kind, name: it.name, description: it.description, category: it.category, path: it.path });
    }
    for (const it of kitNow().kit.items) occurrences.push({ source: KIT_SOURCE, kind: it.kind, name: it.name, description: it.description, category: it.category, path: it.path, kit: it });
    const pNorm = pRoot ? normPath(pRoot) : null;
    const others = allProjects()
      .filter((q) => q && q.id !== p.id)
      .sort((a, b) => cmp(String(a.id), String(b.id)));
    for (const q of others) {
      const qRoot = readableRoot(q, { broad, homeDir: home });
      if (!qRoot || (pNorm && normPath(qRoot) === pNorm)) continue;
      for (const it of readProjectItems(qRoot, { claudeDir: personal, frontmatter })) {
        if (!validName(it.name)) continue;
        occurrences.push({ source: 'project', projectId: q.id, kind: it.kind, name: it.name, description: it.description, category: null, path: it.path });
      }
    }
    const others2 = new Map(others.map((q) => [q.id, q]));
    const otherProfile = (id) => {
      const q = others2.get(id);
      if (!q) return null;
      return { id, primary: profileOf(q).primary };
    };

    // Items already active in every project (personal, claude.ai, enabled plugins, built-in)
    const activeItems = [...r.values()].filter((it) => (it.kind === 'skill' || it.kind === 'agent') && it.global);
    const activeKeys = new Set(activeItems.map((it) => itemKey(it.kind, it.name)));
    const active = activeItems.map((it) => ({
      key: `${it.kind}:${it.name}`,
      kind: it.kind,
      name: it.name,
      description: truncate(it.description, DESC_MAX),
      source: it.source,
      ...(it.plugin ? { plugin: it.plugin } : {}),
      tags: itemTags({ name: it.name, description: it.description, category: null }),
      _words: itemWords(it),
      _usedIn: usedInOf(it.kind, it.name).map(otherProfile).filter(Boolean),
    }));

    // Groups by kind and name
    const groups = new Map();
    for (const o of occurrences) {
      const k = itemKey(o.kind, o.name);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }

    const pool = [];
    for (const [k, occ] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
      if (activeKeys.has(k)) continue; // already active everywhere: listed under active
      const installed = own.has(k);
      // One row per kind and name: the chosen occurrence is what gets installed, the other places are listed in alsoIn
      const usedIn = usedInOf(occ[0].kind, occ[0].name);
      const first = chooseOccurrence(occ, new Set(usedIn));
      const lib = first.source === 'library' ? first : null;
      const kit = first.source === KIT_SOURCE ? first.kit : null;
      const category = lib || kit ? first.category : proposeCategory(first.name, first.description).category;
      // Installed in (other projects): every project holding a copy, and for a library or kit item the projects the
      // roster says it is installed in
      const projectsIn = [...new Set([...occ.filter((o) => o.projectId).map((o) => o.projectId), ...(lib || kit ? r.get(k)?.installedIn || [] : [])])].filter((id) => id !== p.id).sort();
      // Not installable: no hub (or another project problem), or already in the project
      const blocked = problem || (installed ? 'installed' : null);
      pool.push({
        key: `${first.kind}:${first.name}`,
        kind: first.kind,
        name: first.name,
        description: first.description,
        category,
        // A kit item carries its own curated tags (kit.mjs); every other item gets them from name and description
        tags: kit ? sortTags(withImplied(kit.tags)) : itemTags({ name: first.name, description: first.description, category }),
        sources: [placeOf(first)],
        alsoIn: occ
          .filter((o) => o !== first)
          .map(placeOf)
          .slice(0, MAX_ALSO_IN),
        ...(kit ? { stage: kit.stage } : {}),
        installable: !blocked,
        installed,
        ...(blocked && blocked !== 'installed' ? { blocked } : {}),
        _lib: lib,
        _kit: kit,
        _import: lib || kit ? null : first,
        _installedIn: projectsIn.map(otherProfile).filter(Boolean),
        _words: itemWords(first),
        _usedIn: usedIn.map(otherProfile).filter(Boolean),
      });
    }
    // Every pool entry by key, whatever a scoring does with it: skills-apply plans from these (planApplyImports)
    return { pool, active, problem, profile, byKey: new Map(pool.map((c) => [c.key, c])) };
  }

  // The fit of a pool against the project profile, with the tags of an idea added (withIdea) when there is one.
  // Returns the fit with internal fields (_byKey: every pool entry, excluded ones too).
  function scorePool(entry, p, idea) {
    const list = idea ? ideaTags(idea) : [];
    const profile = withIdea(entry.profile, list, idea ? ideaKeywords(idea) : []);
    const kitCtx = kitContext(entry.profile, idea, list);
    const candidates = [];
    const excluded = [];
    for (const c of entry.pool) {
      const s = c._kit ? scoreKitItem(c._kit, profile, { ...kitCtx, installedIn: c._installedIn, usedIn: c._usedIn }) : scoreItem(c.tags, profile, { installedIn: c._installedIn, usedIn: c._usedIn, words: c._words });
      if (s.excluded) {
        excluded.push({ key: c.key, kind: c.kind, name: c.name, stacks: sortTags(s.stacks) });
        continue;
      }
      candidates.push({
        key: c.key,
        kind: c.kind,
        name: c.name,
        description: c.description,
        category: c.category,
        tags: c.tags,
        sources: c.sources,
        alsoIn: c.alsoIn,
        ...(c.stage ? { stage: c.stage } : {}),
        installable: c.installable,
        installed: c.installed,
        ...(c.blocked ? { blocked: c.blocked } : {}),
        confidence: s.confidence,
        score: s.score,
        reasons: s.reasons,
        selected: false,
        _lib: c._lib,
        _kit: c._kit,
        _import: c._import,
      });
    }
    const selected = autoSelect(candidates);
    for (const c of candidates) c.selected = selected.has(c.key);
    candidates.sort(byFit);

    // Already active items that fit (not excluded, score above zero)
    const active = [];
    for (const a of entry.active) {
      const s = scoreItem(a.tags, profile, { usedIn: a._usedIn, words: a._words });
      if (s.excluded || s.score <= 0) continue;
      const { _usedIn, _words, ...pub } = a;
      active.push({ ...pub, confidence: s.confidence, score: s.score, reasons: s.reasons });
    }
    active.sort(byFit);

    excluded.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.key, b.key));
    const base = entry.profile;
    return {
      project: {
        id: p.id,
        tags: sortTags(base.tags.keys()).map((t) => ({ id: t, type: TAG_BY_ID.get(t).type, from: base.tags.get(t) })),
        // The tags the idea gave (named ones with the words that named them, implied ones with the tag behind them)
        ...(idea ? { idea: { tags: list } } : {}),
        entries: base.entries,
        truncated: base.truncated,
      },
      candidates,
      active: active.slice(0, MAX_ACTIVE),
      excluded: { count: excluded.length, sample: excluded.slice(0, MAX_EXCLUDED_SAMPLE) },
      selection: { skills: candidates.filter((c) => c.selected && c.kind === 'skill').length, agents: candidates.filter((c) => c.selected && c.kind === 'agent').length },
      ...(entry.problem ? { problem: entry.problem } : {}),
      _byKey: entry.byKey,
    };
  }

  function dropIdeaFits(projectId) {
    const prefix = `${projectId}\n`;
    for (const k of [...ideaFits.keys()]) if (projectId === undefined || k.startsWith(prefix)) ideaFits.delete(k);
  }

  // Internal fit (with paths) of a project, from the cache while nothing it depends on changed. idea: the text the
  // person typed (normalizeIdea reads it; '' is no idea). Not given (undefined or null): the project's own idea
  // (project.idea, kept in the project memory, docs/start-flow.md step 2), so the project card's badge and a
  // skills-apply without keys (the automatic selection) follow the idea the person saved for the project. The cache
  // key is the idea actually used, so a saved idea and the same text typed share one entry, and a changed saved idea
  // is a new key. The pool is kept per project; the fit without an idea sits with it, the fits of ideas in a small
  // shared cache (MAX_IDEA_FITS, least recently used first out) whose entries hold only while their pool is the
  // current one. Returns { status, fit } or { status: 404, error }.
  function fitOf(projectId, { idea } = {}) {
    const p = catalog?.getProject?.(projectId) || null;
    if (!p) return { status: 404, error: 'not-a-project' };
    const text = normalizeIdea(idea === undefined || idea === null ? p.idea : idea);
    const sig = [hub || '', currentRosterSig(), librarySig(), usageSig(), `kit${kitNow().n}`].join('|');
    let entry = pools.get(p.id);
    const prof = profiles.get(p.id);
    const fresh = entry && entry.sig === sig && prof && entry.profile === prof.profile && foldersUnchanged(prof.profile.folders);
    if (!fresh) {
      entry = { sig, ...buildPool(p) };
      stats.computed++;
      pools.set(p.id, entry);
      dropIdeaFits(p.id);
      entry.plain = scorePool(entry, p, '');
    } else if (!text) stats.cached++;
    if (!text) return { status: 200, fit: entry.plain };
    const k = `${p.id}\n${text}`;
    const hit = ideaFits.get(k);
    ideaFits.delete(k);
    if (hit && hit.entry === entry) {
      ideaFits.set(k, hit);
      stats.cached++;
      return { status: 200, fit: hit.fit };
    }
    const fit = scorePool(entry, p, text);
    stats.scored++;
    ideaFits.set(k, { entry, fit });
    while (ideaFits.size > MAX_IDEA_FITS) ideaFits.delete(ideaFits.keys().next().value);
    return { status: 200, fit };
  }

  // GET /api/projects/<id>/fit[?idea=...] -> { status, body }: the fit without internal fields. idea as in fitOf: not
  // given, the project's saved idea; '' (an explicit empty ?idea=), no idea.
  function get(projectId, { idea } = {}) {
    const r = fitOf(projectId, { idea });
    if (r.status !== 200) return { status: r.status, body: { error: r.error } };
    return { status: 200, body: publicFit(r.fit) };
  }

  // The projects that items not on this computer yet would fit (docs/github-import.md §5): every listed project whose
  // folder can be read, scored with the same tags, conflict rule and bands as its fit, its saved idea included
  // (project.idea). items: [{ kind, name, description, category }]. Returns one list per item, in item order:
  // [{ projectId, confidence (high|medium), score, reasons, installable }] (see fitsForItem).
  function projectsFor(items) {
    const targets = [];
    for (const p of [...allProjects()].sort((a, b) => cmp(String(a?.id), String(b?.id)))) {
      if (!p || !readableRoot(p, { broad, homeDir: home })) continue;
      const base = profileOf(p);
      const text = normalizeIdea(p.idea);
      const profile = text ? withIdea(base, ideaTags(text), ideaKeywords(text)) : base;
      const rp = hub && !isLegacyHub(hub) ? resolveProject({ catalog, projectId: p.id, hubDir: hub, homeDir: home, claudeDir: personal }) : { ok: false };
      targets.push({ id: p.id, profile, installable: rp.ok });
    }
    return (Array.isArray(items) ? items : []).map((it) => fitsForItem(it, targets));
  }

  function invalidate(projectId) {
    libSigCache = null;
    if (projectId === undefined) {
      pools.clear();
      profiles.clear();
    } else {
      pools.delete(projectId);
      profiles.delete(projectId);
    }
    dropIdeaFits(projectId);
  }

  return { get, fitOf, invalidate, projectsFor, stats, ideaCacheSize: () => ideaFits.size };
}

// The projects one item fits (pure): targets are [{ id, profile (projectProfile, withIdea when the project has an idea),
// installable }]. The item's tags come from its name, description and category (itemTags), as for a library item;
// its words order items that share the rest (the idea's other words). Only high ("very good fit") and medium ("good
// fit") are listed, high first, then by score (highest first) and project id.
// Returns [{ projectId, confidence, score, reasons, installable }].
export function fitsForItem(item, targets) {
  const tags = itemTags({ name: item?.name || '', description: item?.description || '', category: item?.category || '' });
  const w = itemWords(item || {});
  const out = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    const s = scoreItem(tags, t.profile, { words: w });
    if (s.excluded || (s.confidence !== 'high' && s.confidence !== 'medium')) continue;
    out.push({ projectId: t.id, confidence: s.confidence, score: s.score, reasons: s.reasons, installable: !!t.installable });
  }
  return out.sort((a, b) => BAND[a.confidence] - BAND[b.confidence] || b.score - a.score || cmp(a.projectId, b.projectId));
}

// The fit as sent to the browser: fields starting with '_' dropped
export function publicFit(fit) {
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
  return { ...strip(fit), candidates: fit.candidates.map(strip) };
}

// ---------------------------------------------------------------------------------------------------------------
// skills-apply plan (contract §3): import, then install
// ---------------------------------------------------------------------------------------------------------------

// The import part of a skills-apply plan. chosen: the keys (or null for the automatic selection). Returns
// { entries, installItems, imports } where entries are the plan entries of this part (op import|skip), installItems
// the items to plan an install for ([{ kind, name, _virtual? }]: _virtual stands in for a library item that an
// import would create, so a dry plan shows the install too) and imports the import plans to run in live mode
// ([{ item, plan }]).
export function planApplyImports({ fit, keys = null, hubDir, homeDir = null, limits = LIMITS }) {
  const entries = [];
  const installItems = [];
  const imports = [];
  const chosen = keys ? keys.map((k) => ({ k, c: fit._byKey.get(k) || null })) : fit.candidates.filter((c) => c.selected).map((c) => ({ k: c.key, c }));
  const taken = new Set();
  for (const { k, c } of chosen) {
    if (!c) {
      const m = KEY_RE.exec(k);
      entries.push({ op: 'skip', kind: m ? m[1] : 'unknown', name: m ? m[2] : String(k).slice(0, 80), key: k, reason: 'not-a-candidate' });
      continue;
    }
    const nameKey = itemKey(c.kind, c.name);
    if (taken.has(nameKey)) {
      entries.push({ op: 'skip', kind: c.kind, name: c.name, key: c.key, reason: 'duplicate' });
      continue;
    }
    taken.add(nameKey);
    if (!c.installable) {
      entries.push({ op: 'skip', kind: c.kind, name: c.name, key: c.key, reason: c.installed ? 'installed' : c.blocked || 'not-installable' });
      continue;
    }
    if (c._lib) {
      installItems.push({ kind: c.kind, name: c.name });
      continue;
    }
    // A kit item is installed straight from the kit folder (install.mjs finds it after the library); it never goes
    // into the library first. _virtual lets a preview show it with the kit copy the fit chose.
    if (c._kit) {
      installItems.push({ kind: c.kind, name: c.name, _virtual: { ...c._kit } });
      continue;
    }
    // Only in other projects: imported into the library first (category proposed from name and description)
    const o = c._import;
    const skill = c.kind === 'skill';
    const source = skill ? o.path : path.dirname(o.path);
    const pick = { path: skill ? '.' : path.basename(o.path), category: c.category };
    const p = planImport({ hubDir, homeDir, source, picks: [pick], limits });
    const e = p.ok ? p.plan[0] : { op: 'skip', kind: c.kind, name: c.name, category: c.category, reason: p.error };
    const entry = { ...e, op: e.op === 'copy' ? 'import' : e.op, kind: c.kind, name: c.name, key: c.key, from: `project:${o.projectId}` };
    entries.push(entry);
    if (e.op === 'copy') {
      imports.push({ item: c, plan: p.plan, entry });
      installItems.push({ kind: c.kind, name: c.name, _virtual: { kind: c.kind, name: c.name, category: e.category, path: o.path, rel: `library/${e.category}/${skill ? 'skills' : 'agents'}/${skill ? c.name : `${c.name}.md`}` } });
    } else if (e.reason === 'same') {
      // The library already holds this very content (it changed since the fit): installed from there
      installItems.push({ kind: c.kind, name: c.name });
    }
  }
  return { entries, installItems, imports };
}
