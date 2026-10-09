// @ts-check
// Suggestions (docs/skills-flow.md §3.1): library items ranked for one project, each with a short reason.
// Signals come from file names and a few small manifest files in the project folder (package.json, pyproject.toml,
// requirements.txt, go.mod, Cargo.toml, pubspec.yaml, project.godot, *.csproj, *.sln, *.uproject, Unity folders and
// the Unity Packages/manifest.json, Dockerfile, .github/workflows) and from the registry packages of a registered
// project. The automatic fit (server/fit.mjs) reads the same signals, also in sub folders its file census finds. Read-only: nothing is
// written and no action mode is needed. Deterministic: the same folder and library give the same list.
import fs from 'node:fs';
import path from 'node:path';
import { isLocalPath } from './fsutil.mjs';
import { normPath } from './util.mjs';
import { listLibrary, isLegacyHub, normText, hasKeyword, lstat, isRealDir, validName, hasStreamColon, isDriveRoot } from './library.mjs';
import { readInstalls } from './install.mjs';
import { PLATFORM, normalizeDir } from './platform.mjs';

const MANIFEST_MAX = 256 * 1024;
export const MAX_SUGGESTIONS = 50;

// package.json dependency names -> signal
export const NPM_SIGNALS = Object.freeze([
  { id: 'react', deps: ['react', 'react-dom'], categories: ['web'], keywords: ['react'] },
  { id: 'next', deps: ['next'], categories: ['web'], keywords: ['nextjs', 'next js'] },
  { id: 'vue', deps: ['vue', 'nuxt'], categories: ['web'], keywords: ['vue', 'nuxt'] },
  { id: 'svelte', deps: ['svelte', '@sveltejs/kit'], categories: ['web'], keywords: ['svelte', 'sveltekit'] },
  { id: 'angular', deps: ['@angular/core'], categories: ['web'], keywords: ['angular'] },
  { id: 'vite', deps: ['vite'], categories: ['web'], keywords: ['vite', 'frontend'] },
  { id: 'expo', deps: ['expo'], categories: ['mobile'], keywords: ['expo', 'react native'] },
  { id: 'react-native', deps: ['react-native'], categories: ['mobile'], keywords: ['react native'] },
  { id: 'electron', deps: ['electron'], categories: ['desktop'], keywords: ['electron'] },
  { id: 'tauri', deps: ['@tauri-apps/api', '@tauri-apps/cli'], categories: ['desktop'], keywords: ['tauri'] },
  { id: 'express', deps: ['express', 'fastify', 'koa', 'hono', '@nestjs/core'], categories: ['web'], keywords: ['express', 'fastify', 'nestjs', 'api', 'backend'] },
  { id: 'prisma', deps: ['prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'mongoose', 'pg', 'mysql2', 'better-sqlite3'], categories: ['data'], keywords: ['prisma', 'database', 'sql', 'postgres'] },
  { id: 'tailwind', deps: ['tailwindcss'], categories: ['design'], keywords: ['tailwind'] },
  { id: 'tests', deps: ['jest', 'vitest', 'mocha', 'playwright', '@playwright/test', 'cypress', '@testing-library/react'], categories: ['testing'], keywords: ['jest', 'vitest', 'playwright', 'cypress', 'testing'] },
  { id: 'llm', deps: ['openai', '@anthropic-ai/sdk', 'langchain', '@langchain/core', 'ai'], categories: ['ai'], keywords: ['llm', 'openai', 'anthropic', 'claude api'] },
  { id: 'typescript', deps: ['typescript'], categories: [], keywords: ['typescript'] },
]);

// Python requirement names -> signal (pyproject.toml, requirements.txt)
const PY_SIGNALS = Object.freeze([
  { id: 'django', deps: ['django'], categories: ['web'], keywords: ['django'] },
  { id: 'flask', deps: ['flask'], categories: ['web'], keywords: ['flask'] },
  { id: 'fastapi', deps: ['fastapi'], categories: ['web'], keywords: ['fastapi', 'api'] },
  { id: 'pandas', deps: ['pandas', 'numpy', 'polars', 'scipy'], categories: ['data'], keywords: ['pandas', 'numpy', 'dataframe'] },
  { id: 'ml', deps: ['torch', 'tensorflow', 'transformers', 'scikit-learn', 'keras'], categories: ['ai'], keywords: ['pytorch', 'tensorflow', 'machine learning'] },
  { id: 'llm-py', deps: ['openai', 'anthropic', 'langchain'], categories: ['ai'], keywords: ['llm', 'openai', 'anthropic'] },
  { id: 'pytest', deps: ['pytest'], categories: ['testing'], keywords: ['pytest', 'testing'] },
]);

// Unity package ids (Packages/manifest.json of a Unity project) -> signal. Only packages a project adds on purpose:
// the ones every template ships (test framework, uGUI, input system) say nothing about the project.
const UNITY_SIGNALS = Object.freeze([
  { id: 'unity-multiplayer', match: /^com\.unity\.(?:netcode|multiplayer|transport)|^com\.unity\.services\.(?:multiplayer|lobby|relay|matchmaker)|fishnet|mirror-networking|photon/, categories: ['game'], keywords: ['multiplayer', 'netcode'] },
  { id: 'unity-rendering', match: /^com\.unity\.(?:render-pipelines\.(?:universal|high-definition)|shadergraph|visualeffectgraph)$/, categories: ['game'], keywords: ['shader', 'shaders', 'vfx', 'rendering'] },
  { id: 'unity-localization', match: /^com\.unity\.localization$/, categories: [], keywords: ['localization'] },
]);

// Signals from the dependency names of a Unity Packages/manifest.json text, in the table order
function unityPackageSignals(text) {
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const deps = Object.keys(j?.dependencies && typeof j.dependencies === 'object' ? j.dependencies : {}).map((d) => d.toLowerCase());
  return UNITY_SIGNALS.filter((s) => deps.some((d) => s.match.test(d))).map((s) => signal(s.id, 'Packages/manifest.json', s.categories, s.keywords));
}

export function readSmall(file) {
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > MANIFEST_MAX) return null;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch {
    return null;
  }
}

export function names(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const signal = (id, from, categories, keywords) => ({ id, from, categories, keywords });

// Python requirement names in a requirements.txt or pyproject.toml (lower-cased, extras and versions dropped)
function pythonDeps(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    // "name>=1.0", "name[extra]", '"name>=1",' inside a TOML list, name = "^1.0" in a Poetry table
    const m = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (m) out.add(m[1].toLowerCase().replace(/_/g, '-'));
  }
  return out;
}

// The folder whose names are read for a project root: the root itself when it is a real folder. A root that is a
// junction or a folder link is followed one hop only, and only when its target (read from the link itself with
// readlink, never by opening the target) is a local drive path without a ':' after the drive letter, is a real
// folder (not another link) and is not broad (a drive root, or what `broad` says). A link to a network share is
// never opened (it could block on an offline server). Everything below that folder is read without following links,
// as for any project. null: nothing is read.
/** @param {string} dir @param {{ broad?: (dir: string) => boolean }} [options] */
export function signalRoot(dir, { broad = () => false } = {}) {
  const st = dir ? lstat(dir) : null;
  if (!st) return null;
  if (st.isDirectory()) return dir;
  if (!st.isSymbolicLink()) return null;
  let target;
  try {
    target = fs.readlinkSync(dir);
  } catch {
    return null;
  }
  if (typeof target !== 'string' || !target) return null;
  if (!PLATFORM.path.isAbsolute(target)) target = PLATFORM.path.resolve(PLATFORM.path.dirname(dir), target);
  if (!isLocalPath(target) || hasStreamColon(target)) return null;
  const t = normalizeDir(target);
  if (isDriveRoot(t) || !isRealDir(t) || broad(t)) return null;
  return t;
}

// Signals of a project folder, in a fixed order. Reads only names and the small manifest files listed above.
// broad(folder): true for a folder that is never read (see signalRoot).
/** @param {string} dir @param {{ broad?: (dir: string) => boolean }} [options] */
export function projectSignals(dir, { broad = () => false } = {}) {
  const out = [];
  dir = signalRoot(dir, { broad });
  if (!dir) return out;
  const entries = names(dir);
  const has = (n) => entries.some((d) => d.name.toLowerCase() === n.toLowerCase());
  const pkg = readSmall(path.join(dir, 'package.json'));
  if (pkg) {
    let j = null;
    try {
      j = JSON.parse(pkg);
    } catch {
      j = null;
    }
    const deps = new Set([...Object.keys(j?.dependencies || {}), ...Object.keys(j?.devDependencies || {}), ...Object.keys(j?.peerDependencies || {})]);
    // Any package.json is a Node.js project (like any requirements.txt is a Python one), whatever its packages
    if (j) out.push(signal('node', 'package.json', [], ['node', 'nodejs', 'javascript']));
    for (const s of NPM_SIGNALS) if (s.deps.some((d) => deps.has(d))) out.push(signal(s.id, 'package.json', s.categories, s.keywords));
  }
  const py = [readSmall(path.join(dir, 'pyproject.toml')), readSmall(path.join(dir, 'requirements.txt'))];
  if (py.some((t) => t !== null)) {
    const from = py[0] !== null ? 'pyproject.toml' : 'requirements.txt';
    const deps = new Set([...pythonDeps(py[0]), ...pythonDeps(py[1])]);
    out.push(signal('python', from, [], ['python']));
    for (const s of PY_SIGNALS) if (s.deps.some((d) => deps.has(d))) out.push(signal(s.id, from, s.categories, s.keywords));
  }
  if (has('go.mod')) out.push(signal('go', 'go.mod', [], ['golang']));
  if (has('Cargo.toml')) {
    out.push(signal('rust', 'Cargo.toml', [], ['rust', 'cargo']));
    if (/\btauri\b/.test(readSmall(path.join(dir, 'Cargo.toml')) || '')) out.push(signal('tauri', 'Cargo.toml', ['desktop'], ['tauri']));
  }
  const csproj = entries.find((d) => d.isFile() && /\.csproj$/i.test(d.name));
  const sln = entries.find((d) => d.isFile() && /\.sln$/i.test(d.name));
  if (csproj || sln) out.push(signal('dotnet', csproj ? '.csproj' : '.sln', [], ['dotnet', 'csharp', 'net core']));
  if (isRealDir(path.join(dir, 'Assets')) && isRealDir(path.join(dir, 'ProjectSettings'))) {
    out.push(signal('unity', 'Assets/, ProjectSettings/', ['game'], ['unity']));
    // The package manifest is read only through a real Packages folder (never through a link)
    const manifest = isRealDir(path.join(dir, 'Packages')) ? readSmall(path.join(dir, 'Packages', 'manifest.json')) : null;
    if (manifest) out.push(...unityPackageSignals(manifest));
  }
  if (entries.some((d) => d.isFile() && /\.uproject$/i.test(d.name))) out.push(signal('unreal', '.uproject', ['game'], ['unreal']));
  if (has('project.godot')) out.push(signal('godot', 'project.godot', ['game'], ['godot', 'gdscript']));
  if (has('pubspec.yaml')) out.push(signal('flutter', 'pubspec.yaml', ['mobile'], ['flutter', 'dart']));
  if (entries.some((d) => d.isFile() && /^dockerfile$/i.test(d.name))) out.push(signal('docker', 'Dockerfile', ['devops'], ['docker', 'container']));
  if (isRealDir(path.join(dir, '.github', 'workflows'))) out.push(signal('ci', '.github/workflows', ['devops'], ['github actions', 'ci']));
  return out;
}

// Registry packages that name a library category: a strong signal (the user chose them for this project)
export function registrySignals(packages, categories) {
  const out = [];
  for (const k of Array.isArray(packages) ? packages : []) {
    if (typeof k === 'string' && categories.has(k) && !out.some((s) => s.id === k)) out.push(signal(k, 'registry', [k], []));
  }
  return out;
}

// Scores library items against the signals: a category match weighs 2 (4 for a registry package), a keyword in the
// name 3, a keyword only in the description 1. Items without a score are left out, and so is an item whose name
// fails the name rule (an install request with it would be refused as a whole: contract §3.9). Sorted by score,
// then kind (skills first), then name. reason: { from, signal, match: category|name|description } of the strongest
// signal.
export function rankItems(library, signals, { max = MAX_SUGGESTIONS } = {}) {
  const out = [];
  for (const it of library) {
    if (!validName(it.name)) continue;
    const n = normText(it.name);
    const d = normText(it.description);
    let score = 0;
    let best = null;
    for (const s of signals) {
      let add = 0;
      let match = null;
      if (s.categories.includes(it.category)) {
        add += s.from === 'registry' ? 4 : 2;
        match = 'category';
      }
      if (s.keywords.some((k) => hasKeyword(n, k))) {
        add += 3;
        match = match || 'name';
      } else if (s.keywords.some((k) => hasKeyword(d, k))) {
        add += 1;
        match = match || 'description';
      }
      if (!add) continue;
      score += add;
      if (!best || add > best.add) best = { add, reason: { from: s.from, signal: s.id, match } };
    }
    if (score > 0) out.push({ kind: it.kind, name: it.name, category: it.category, description: it.description, score, reason: best.reason });
  }
  const lc = (s) => String(s).toLowerCase();
  out.sort((a, b) => b.score - a.score || (a.kind === b.kind ? 0 : a.kind === 'skill' ? -1 : 1) || (lc(a.name) < lc(b.name) ? -1 : lc(a.name) > lc(b.name) ? 1 : 0));
  return out.slice(0, max);
}

// GET /api/projects/<id>/suggestions -> { status, body }. body: { project, signals: [{ id, from }], items: [{ kind,
// name, category, description, score, reason, installed, installedBy: 'sibersentez'|'project'|null, targets }],
// problem? ('legacy-hub' | 'no-hub') }
export function projectSuggestions({ catalog, projectId, hubDir = catalog?.hubDir || null }) {
  const p = catalog?.getProject?.(projectId) || null;
  if (!p) return { status: 404, body: { error: 'not-a-project' } };
  const body = { project: p.id, signals: [], items: [] };
  if (!hubDir) return { status: 200, body: { ...body, problem: 'no-hub' } };
  if (isLegacyHub(hubDir)) return { status: 200, body: { ...body, problem: 'legacy-hub' } };
  const library = listLibrary(hubDir);
  const categories = new Set(library.map((it) => it.category));
  const isBroad = (dir) => typeof catalog.isBroad === 'function' && !!catalog.isBroad(normPath(dir));
  const usable = p.path && !p.broad && !p.tmpOnly && isLocalPath(p.path) && !hasStreamColon(p.path) && !isBroad(p.path);
  const signals = [...(p.kind === 'registered' ? registrySignals(p.packages, categories) : []), ...(usable ? projectSignals(p.path, { broad: isBroad }) : [])];
  body.signals = signals.map((s) => ({ id: s.id, from: s.from }));
  const record = readInstalls(hubDir).installs.filter((r) => r.project === p.id);
  const roster = catalog.roster instanceof Map ? catalog.roster : new Map();
  body.items = rankItems(library, signals).map((it) => {
    const mine = record.filter((r) => r.kind === it.kind && r.name.toLowerCase() === it.name.toLowerCase());
    const inProject = (roster.get(`${it.kind}:${it.name}`.toLowerCase())?.installedIn || []).includes(p.id);
    return { ...it, installed: mine.length > 0 || inProject, installedBy: mine.length ? 'sibersentez' : inProject ? 'project' : null, targets: mine.map((r) => r.target).sort() };
  });
  return { status: 200, body };
}
