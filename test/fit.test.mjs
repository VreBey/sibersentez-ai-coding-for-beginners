// Automatic skill fit tests (docs/auto-skills.md §5): the tag dictionary, the file census, the candidate pool, the
// scoring, the automatic selection, the fit cache, GET /api/projects/<id>/fit and the skills-apply action.
// Run: node --test test/fit.test.mjs
// Hermetic: a fake hub, a fake home and fake projects under the system temp folder; no real process is started
// (spawn is injected), the real home, hub and projects are never read or written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createActions, SKILL_ACTIONS } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { initHub } from '../server/hub.mjs';
import { treeHash } from '../server/library.mjs';
import { readInstalls } from '../server/install.mjs';
import { TAGS, TAG_BY_ID, STACK_TAGS, TOPIC_TAGS, tagsInText, itemTags, primaryStacks, withImplied, sortTags } from '../server/tags.mjs';
import { CENSUS, CENSUS_SKIP, SELECT_CAPS, LIBRARY_SIG_MS, SCORE, HIGH_SCORE, MEDIUM_SCORE, KEY_RE, census, censusTags, projectProfile, readProjectItems, scoreItem, autoSelect, createFit, byFit, planApplyImports } from '../server/fit.mjs';

// ---------------- fake world ----------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-fit-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });

const write = (file, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const exists = (p) => fs.existsSync(p);
const junction = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
};
const skillAt = (dir, name, desc, group = ['.claude', 'skills']) => write(path.join(dir, ...group, name, 'SKILL.md'), fm(name, desc));
const agentAt = (dir, name, desc) => write(path.join(dir, '.claude', 'agents', `${name}.md`), fm(name, desc));
const libSkill = (hub, cat, name, desc) => write(path.join(hub, 'library', cat, 'skills', name, 'SKILL.md'), fm(name, desc));
const libAgent = (hub, cat, name, desc) => write(path.join(hub, 'library', cat, 'agents', `${name}.md`), fm(name, desc));
const unityAt = (dir) => {
  fs.mkdirSync(path.join(dir, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ProjectSettings'), { recursive: true });
  write(path.join(dir, 'Assets', 'Scripts', 'Player.cs'), 'class Player {}');
};
const nextAt = (dir) => write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15', react: '19' }, devDependencies: { typescript: '5' } }));
const rnAt = (dir) => write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '51', 'react-native': '0.74', react: '18' } }));

let worldN = 0;
// A hub, a home and projects; catalog double with the fields the fit reads
function world({ legacy = false } = {}) {
  const base = path.join(ROOT, `w${++worldN}`);
  const hub = path.join(base, 'hub');
  if (legacy) {
    write(path.join(hub, 'registry', 'projeler.json'), JSON.stringify({ projeler: [] }));
    write(path.join(hub, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [] }));
  } else initHub(hub);
  const projects = [];
  const roster = new Map();
  const catalog = {
    hubDir: legacy ? hub : hub,
    homeDir: HOME,
    claudeDir: CLAUDE,
    roster,
    version: 1,
    getProject: (id) => projects.find((p) => p.id === id) || null,
    allProjects: () => projects,
  };
  const project = (id, { via = ['claude-code'], kind = 'adhoc', packages = [], make = null } = {}) => {
    const dir = path.join(base, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    if (make) make(dir);
    const p = { id, name: id, kind, path: dir, exists: true, via, packages };
    projects.push(p);
    return dir;
  };
  const active = (kind, name, description, source = 'personal', extra = {}) => roster.set(`${kind}:${name}`.toLowerCase(), { kind, name, source, sources: [source], description, installedIn: [], global: true, ...extra });
  const bump = () => {
    catalog.version++;
    catalog.roster = new Map(catalog.roster);
  };
  return { base, hub, lib: path.join(hub, 'library'), projects, roster, catalog, project, active, bump, dir: (id) => projects.find((p) => p.id === id).path };
}

const usage = (skills = {}, agents = {}) => ({ usage: { skills: new Map(Object.entries(skills).map(([k, ids]) => [k, { projects: new Set(ids) }])), agents: new Map(Object.entries(agents).map(([k, ids]) => [k, { projects: new Set(ids) }])) } });
const keys = (list) => list.map((c) => c.key);
const byKey = (body, key) => body.candidates.find((c) => c.key === key);

// Every path under a folder with size and modification time: "nothing was written" means this does not change
function snapshotTree(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)}|${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// ---------------- tag dictionary (§2.2) ----------------
test('tags: every tag is a stack tag (framework or language) or a topic tag; ids are unique and the two sets do not overlap', () => {
  assert.equal(new Set(TAGS.map((t) => t.id)).size, TAGS.length);
  for (const t of TAGS) {
    assert.ok(['stack', 'topic'].includes(t.type), t.id);
    assert.ok(t.type === 'topic' ? t.kind === 'topic' : ['framework', 'language'].includes(t.kind), t.id);
    assert.match(t.id, /^[a-z][a-z-]*$/);
    for (const x of t.implies) assert.ok(TAG_BY_ID.has(x), `${t.id} implies ${x}`);
    assert.ok(t.words.length > 0, t.id);
  }
  assert.equal(STACK_TAGS.filter((t) => TOPIC_TAGS.includes(t)).length, 0);
  for (const id of ['unity', 'unreal', 'godot', 'nextjs', 'react-native', 'expo', 'electron', 'django', 'fastapi']) assert.equal(TAG_BY_ID.get(id).kind, 'framework', id);
  for (const id of ['csharp', 'python', 'typescript', 'cpp']) assert.equal(TAG_BY_ID.get(id).kind, 'language', id);
  for (const id of ['testing', 'security', 'docs', 'design', 'devops', 'database']) assert.equal(TAG_BY_ID.get(id).type, 'topic', id);
});

test('tags: synonyms in English and Turkish as whole words; the longest phrase wins; proper nouns need a capital in a description, not in a name', () => {
  const t = (s, o) => [...tagsInText(s, o)].sort();
  // The contract's examples
  for (const s of ['Unity', 'MonoBehaviour lifecycle', 'prefab variants', 'ScriptableObject data', 'URP', 'HDRP', 'Shader Graph', 'netcode']) assert.ok(tagsInText(s).has('unity'), s);
  for (const s of ['Next.js', 'nextjs', 'the App Router']) assert.deepEqual(t(s), ['nextjs'], s);
  // Longest phrase: React Native is not React; Shader Graph is Unity and graphics
  assert.deepEqual(t('React Native screens'), ['react-native']);
  assert.deepEqual(t('Shader Graph nodes'), ['graphics', 'unity']);
  // Proper nouns
  assert.deepEqual(t('react to player input', { strictCase: true }), []);
  assert.deepEqual(t('Builds React pages', { strictCase: true }), ['react']);
  assert.deepEqual(t('react pages'), ['react'], 'names are lower case: any case counts');
  assert.deepEqual(t('Expo router', { strictCase: true }), ['expo']);
  assert.deepEqual(t('an expo of ideas', { strictCase: true }), []);
  // Folded spellings
  assert.deepEqual(t('C# and .NET'), ['csharp']);
  assert.deepEqual(t('ASP.NET Core APIs'), ['backend', 'dotnet'], 'APIs are a backend topic (docs/start-flow.md)');
  assert.deepEqual(t('Modern C++ code'), ['cpp']);
  // Whole words only
  assert.deepEqual(t('community unityish reactor'), []);
  // Turkish synonyms and stems (suffixes)
  assert.deepEqual(t('güvenlik denetimi'), ['security']);
  assert.deepEqual(t('Güvenliği artır'), ['security']);
  assert.deepEqual(t('oyun tasarımı'), ['design', 'gamedev']);
  assert.deepEqual(t('Veritabanı şeması'), ['database']);
  assert.deepEqual(t('birim testleri'), ['testing']);
  assert.deepEqual(t('çok oyunculu maç'), ['multiplayer'], 'the phrase takes the word: not also oyun*');
  assert.deepEqual(t('oyuncular ve görsel efektler'), ['gamedev', 'graphics'], 'a phrase whose last word is a stem');
  assert.deepEqual(t('veri analizi'), ['data']);
  assert.deepEqual(t('arayüz ve ses efekti'), ['audio', 'ui']);
  assert.deepEqual(t('İNCELEME belgesi'), ['docs'], 'dotted capital I is folded');
  assert.deepEqual(t('yerelleştirme ve çeviri'), ['localization']);
  // English topics
  assert.deepEqual(t('OWASP vulnerabilities'), ['security']);
  assert.deepEqual(t('Dockerfile and CI/CD'), ['devops']);
  assert.deepEqual(t('PostgreSQL migrations'), ['database']);
});

test('tags: every synonym in the dictionary gives its own tag (no entry is dead or shadowed)', () => {
  for (const t of TAGS) {
    for (const w of t.words) {
      const text = w.endsWith('*') ? `${w.slice(0, -1)}lik` : w;
      assert.ok(tagsInText(text, { strictCase: true }).has(t.id), `${t.id}: ${w}`);
    }
  }
});

test('tags: items get tags from name, description and category, plus what they imply; primary stacks are the frameworks, else the languages', () => {
  assert.deepEqual(itemTags({ name: 'unity-shader-graph', description: '' }), ['unity', 'csharp', 'gamedev', 'graphics']);
  assert.deepEqual(itemTags({ name: 'expo-router', description: 'Navigation' }), ['react-native', 'expo', 'mobile']);
  assert.deepEqual(itemTags({ name: 'writing', description: 'Docs', category: 'docs' }), ['docs']);
  assert.deepEqual(itemTags({ name: 'x', description: '', category: 'general' }), []);
  assert.deepEqual(itemTags({ name: 'unity:ui-toolkit', description: '' }), ['unity', 'csharp', 'gamedev', 'ui'], 'a plugin item name counts whole');
  assert.deepEqual([...primaryStacks(['unity', 'csharp', 'gamedev'])], ['unity']);
  assert.deepEqual([...primaryStacks(['dotnet', 'csharp'])], ['dotnet']);
  assert.deepEqual([...primaryStacks(['python', 'testing'])], ['python']);
  assert.deepEqual([...primaryStacks(['testing'])], []);
  assert.deepEqual(sortTags(withImplied(['typescript'])), ['typescript', 'javascript']);
  assert.deepEqual(itemTags({ name: 'python-best-practices', description: 'Idiomatic Python' }), ['python']);
});

// ---------------- file census (§2.1) ----------------
test('census: depth 3 — entries up to 3 levels below the project are counted, deeper ones are not; breadth first', () => {
  const dir = path.join(ROOT, 'census-depth');
  write(path.join(dir, 'a.py'));
  write(path.join(dir, 'l1', 'b.py'));
  write(path.join(dir, 'l1', 'l2', 'c.py'));
  write(path.join(dir, 'l1', 'l2', 'l3', 'd.py'));
  write(path.join(dir, 'l1', 'l2', 'l3', 'l4', 'e.py'));
  const c = census(dir);
  assert.equal(CENSUS.maxDepth, 3);
  assert.deepEqual(c.files.map((f) => f.rel), ['a.py', 'l1/b.py', 'l1/l2/c.py'], 'level 4 is not listed');
  assert.deepEqual(c.dirs.map((d) => d.rel), ['l1', 'l1/l2', 'l1/l2/l3'], 'the level-3 folder is counted, not entered');
  assert.equal(c.exts.get('.py').count, 3);
  assert.equal(c.entries, 6);
  assert.equal(c.truncated, false);
  assert.deepEqual(census(dir, { maxDepth: 1 }).files.map((f) => f.rel), ['a.py']);
  assert.deepEqual([...censusTags(c)], [['python', '*.py x3']]);
  assert.equal(census(path.join(ROOT, 'no-such-folder')).entries, 0);
});

test('census: at most 5,000 entries; the rest is not read and truncated says so; the result is deterministic', () => {
  const dir = path.join(ROOT, 'census-many');
  for (let i = 0; i < 5100; i++) write(path.join(dir, `f${String(i).padStart(4, '0')}.ts`));
  write(path.join(dir, 'zz', 'late.tsx'));
  const c = census(dir);
  assert.equal(CENSUS.maxEntries, 5000);
  assert.equal(c.entries, 5000);
  assert.equal(c.truncated, true);
  assert.equal(c.exts.get('.ts').count, 5000);
  assert.ok(!c.exts.has('.tsx'), 'nothing past the limit is read');
  assert.equal(c.files.at(-1).rel, 'f4999.ts', 'byte order');
  assert.deepEqual(census(dir), c);
  assert.equal(census(dir, { maxEntries: 10 }).entries, 10);
});

test('census: node_modules, .git, Library, Temp, obj, bin, dist, build and .venv are counted but never entered', () => {
  const dir = path.join(ROOT, 'census-skip');
  const contract = ['node_modules', '.git', 'Library', 'Temp', 'obj', 'bin', 'dist', 'build', '.venv'];
  for (const s of contract) {
    assert.ok(CENSUS_SKIP.includes(s.toLowerCase()), s);
    for (let i = 0; i < 3; i++) write(path.join(dir, s, `x${i}.tsx`));
  }
  write(path.join(dir, 'src', 'a.cs'));
  const c = census(dir);
  assert.ok(!c.exts.has('.tsx'), 'nothing inside a skipped folder is read');
  assert.deepEqual(c.dirs.map((d) => d.name).sort(), [...contract.map((s) => s.toLowerCase()), 'src'].sort());
  assert.deepEqual(c.files.map((f) => f.rel), ['src/a.cs']);
});

test('census: a junction or a link is counted and never followed (a linked React app does not make a Unity project a React project)', () => {
  const app = path.join(ROOT, 'census-link-target');
  for (let i = 0; i < 5; i++) write(path.join(app, `c${i}.tsx`));
  const dir = path.join(ROOT, 'census-link');
  unityAt(dir);
  junction(app, path.join(dir, 'web'));
  junction(app, path.join(dir, 'Assets', 'linked'));
  const c = census(dir);
  assert.ok(!c.exts.has('.tsx'));
  assert.ok(!c.dirs.some((d) => d.name === 'web' || d.name === 'linked'), 'a link is not a folder of the project');
  const tags = [...censusTags(c).keys()];
  assert.ok(tags.includes('unity') && !tags.includes('react'), tags.join(','));
});

// ---------------- project profile ----------------
test('project profile: manifest signals, census and sub folder manifests (Unity in a sub folder with its package manifest, a monorepo app); registry packages only for a registered project', () => {
  const w = world();
  const pc = w.project('pc', {
    make: (d) => {
      unityAt(path.join(d, 'Game'));
      write(path.join(d, 'Game', 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.firstgeargames.fishnet': 'x', 'com.unity.render-pipelines.universal': '17', 'com.unity.test-framework': '1' } }));
      write(path.join(d, 'Game', 'Game.Tests.EditMode.csproj'), '<Project/>');
      fs.mkdirSync(path.join(d, 'design', 'gdd'), { recursive: true });
      fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
      for (let i = 0; i < 3; i++) write(path.join(d, 'tools', `t${i}.py`));
    },
  });
  const prof = projectProfile(w.projects.find((p) => p.id === 'pc'));
  const tags = Object.fromEntries(prof.tags);
  assert.equal(tags.unity, 'Game/Assets, ProjectSettings');
  assert.equal(tags.multiplayer, 'Game/Packages/manifest.json');
  assert.equal(tags.graphics, 'Game/Packages/manifest.json');
  assert.ok(tags.testing && tags.docs && tags.design && tags.gamedev && tags.python && tags.csharp, Object.keys(tags).join(','));
  assert.deepEqual([...prof.primary], ['unity'], 'the engine is the primary stack; python and C# are not');
  assert.ok(!prof.tags.has('localization'), 'the test framework every template ships says nothing');
  assert.ok(pc);
  // A monorepo: the app's package.json in a sub folder
  w.project('mono', { make: (d) => (write(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { turbo: '2' } })), rnAt(path.join(d, 'apps', 'mobile')), nextAt(path.join(d, 'apps', 'web'))) });
  const mono = projectProfile(w.projects.find((p) => p.id === 'mono'));
  for (const t of ['react-native', 'expo', 'nextjs', 'react', 'typescript', 'mobile', 'web']) assert.ok(mono.tags.has(t), t);
  // Registry packages: a registered project only
  w.project('reg', { kind: 'registered', packages: ['docs', 'game', 'ccgs'] });
  w.project('adh', { kind: 'adhoc', packages: ['docs'] });
  assert.deepEqual(sortTags(projectProfile(w.projects.find((p) => p.id === 'reg')).tags.keys()), ['gamedev', 'docs']);
  assert.deepEqual([...projectProfile(w.projects.find((p) => p.id === 'adh')).tags.keys()], []);
  // A broad or missing folder is never read
  assert.equal(projectProfile({ id: 'b', kind: 'adhoc', path: w.dir('pc'), broad: true }).entries, 0);
  assert.equal(projectProfile({ id: 'm', kind: 'adhoc', path: path.join(w.base, 'missing') }).entries, 0);
});

// ---------------- candidate pool (§1) ----------------
test('pool: library items and the items of other projects (.claude/skills, .claude/agents, .agents/skills); the project itself is never a source', () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-shaders', 'Shader Graph for URP');
  w.project('me', { make: unityAt });
  w.project('other', {
    make: (d) => {
      unityAt(d);
      skillAt(d, 'unity-input', 'Unity input system');
      agentAt(d, 'unity-specialist', 'Unity engine specialist');
      skillAt(d, 'unity-audio', 'Unity audio mixers', ['.agents', 'skills']);
    },
  });
  const body = createFit({ catalog: w.catalog }).get('me').body;
  assert.deepEqual(keys(body.candidates).sort(), ['agent:unity-specialist', 'skill:unity-audio', 'skill:unity-input', 'skill:unity-shaders']);
  assert.deepEqual(byKey(body, 'skill:unity-shaders').sources, ['library']);
  assert.deepEqual(byKey(body, 'skill:unity-input').sources, ['project:other']);
  assert.equal(byKey(body, 'skill:unity-input').category, 'game', 'category proposed from name and description');
  for (const c of body.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['alsoIn', 'category', 'confidence', 'description', 'installable', 'installed', 'key', 'kind', 'name', 'reasons', 'score', 'selected', 'sources', 'tags']);
    assert.deepEqual(c.alsoIn, [], 'each item is in one place here');
    assert.ok(!JSON.stringify(c).includes(w.base), 'no path in the reply');
  }
  // From the other side: my items are candidates there, its own are not (they are nowhere else)
  skillAt(w.dir('me'), 'unity-save', 'Unity save system');
  const other = createFit({ catalog: w.catalog }).get('other').body;
  assert.ok(byKey(other, 'skill:unity-save'));
  assert.equal(byKey(other, 'skill:unity-input'), undefined);
  assert.equal(byKey(other, 'agent:unity-specialist'), undefined);
});

test('pool: items the project already has (any target, the install record or the roster) are marked installed, never selected and not installable', () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-a', 'Unity A');
  libSkill(w.hub, 'game', 'unity-b', 'Unity B');
  libSkill(w.hub, 'game', 'unity-c', 'Unity C');
  libSkill(w.hub, 'game', 'unity-d', 'Unity D');
  const me = w.project('me', { make: unityAt });
  skillAt(me, 'unity-a', 'mine', ['.agents', 'skills']);
  libSkill(w.hub, 'game', 'unity-e', 'Unity E');
  // unity-b: recorded and its folder is there; unity-e: recorded, but the person deleted its folder
  fs.mkdirSync(path.join(me, '.claude', 'skills', 'unity-b'), { recursive: true });
  const rec = (name) => ({ project: 'me', target: 'claude', kind: 'skill', name, path: path.join(me, '.claude', 'skills', name), hash: 'h', source: 'x', installedAt: 'x' });
  write(path.join(w.hub, 'registry', 'installs.json'), JSON.stringify({ version: 1, installs: [rec('unity-b'), rec('unity-e')] }));
  w.roster.set('skill:unity-c', { kind: 'skill', name: 'unity-c', source: 'library', sources: ['library', 'project'], installedIn: ['me'], global: false });
  const body = createFit({ catalog: w.catalog }).get('me').body;
  assert.equal(byKey(body, 'skill:unity-e').installed, false, 'a record whose folder is gone is not installed: Start sets it up again');
  for (const k of ['skill:unity-a', 'skill:unity-b', 'skill:unity-c']) {
    const c = byKey(body, k);
    assert.equal(c.installed, true, k);
    assert.equal(c.installable, false, k);
    assert.equal(c.selected, false, k);
  }
  assert.equal(byKey(body, 'skill:unity-d').installed, false);
});

test('pool: one row per kind and name, whatever the content: the library copy first, else the best project copy (used there, then the most recently changed); the other places in alsoIn', () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-ui', 'Unity UI Toolkit');
  w.project('me', { make: unityAt });
  const a = w.project('a', { make: unityAt });
  const b = w.project('b', { make: unityAt });
  const c = w.project('c', { make: unityAt });
  // Same content as the library in a and b; other content in c: still one row, installed from the library
  fs.cpSync(path.join(w.lib, 'game', 'skills', 'unity-ui'), path.join(a, '.claude', 'skills', 'unity-ui'), { recursive: true });
  fs.cpSync(path.join(w.lib, 'game', 'skills', 'unity-ui'), path.join(b, '.claude', 'skills', 'unity-ui'), { recursive: true });
  skillAt(c, 'unity-ui', 'Unity UI Toolkit');
  write(path.join(c, '.claude', 'skills', 'unity-ui', 'extra.md'), 'more');
  // Three projects with the same agent, one of them with other content (the unity-specialist case: one row, not three)
  agentAt(a, 'unity-specialist', 'Unity specialist');
  agentAt(b, 'unity-specialist', 'Unity specialist, other text');
  agentAt(c, 'unity-specialist', 'Unity specialist');
  const old = new Date(Date.now() - 3600_000);
  for (const p of [a, c]) fs.utimesSync(path.join(p, '.claude', 'agents', 'unity-specialist.md'), old, old);
  const body = createFit({ catalog: w.catalog }).get('me').body;
  const ui = body.candidates.filter((x) => x.name === 'unity-ui');
  assert.deepEqual(keys(ui), ['skill:unity-ui']);
  assert.deepEqual(ui[0].sources, ['library']);
  assert.deepEqual(ui[0].alsoIn, ['project:a', 'project:b', 'project:c']);
  assert.equal(ui[0].installable, true);
  assert.ok(!('blocked' in ui[0]), 'no library conflict: the row is the library item');
  const spec = body.candidates.filter((x) => x.name === 'unity-specialist');
  assert.deepEqual(keys(spec), ['agent:unity-specialist'], 'three copies, one row');
  assert.deepEqual(spec[0].sources, ['project:b'], 'the most recently changed copy');
  assert.deepEqual(spec[0].alsoIn, ['project:a', 'project:c']);
  assert.equal(spec[0].description, 'Unity specialist, other text', 'the row shows the copy it installs');
  for (const x of body.candidates) assert.match(x.key, KEY_RE);
  assert.equal(body.candidates.filter((x) => x.selected && x.name === 'unity-specialist').length, 0, 'only in other projects: never selected unseen');
  // A copy in a project where the item was used wins over a newer one
  const used = createFit({ catalog: w.catalog, ingest: usage({}, { 'unity-specialist': ['c'] }) }).get('me').body;
  assert.deepEqual(byKey(used, 'agent:unity-specialist').sources, ['project:c']);
  assert.deepEqual(byKey(used, 'agent:unity-specialist').alsoIn, ['project:a', 'project:b']);
  // The chosen copy is what skills-apply imports (then installs)
  const f = createFit({ catalog: w.catalog }).fitOf('me').fit;
  const part = planApplyImports({ fit: f, keys: ['agent:unity-specialist'], hubDir: w.hub, homeDir: HOME });
  assert.deepEqual(part.entries.map((e) => [e.op, e.from]), [['import', 'project:b']]);
  // An item over the size limit is still one candidate (the import refuses it later, with its reason)
  for (let i = 0; i < 501; i++) write(path.join(a, '.claude', 'skills', 'unity-big', 'f', `${i}.txt`));
  skillAt(a, 'unity-big', 'Unity big');
  skillAt(b, 'unity-big', 'Unity big');
  const big = createFit({ catalog: w.catalog }).get('me').body.candidates.filter((x) => x.name === 'unity-big');
  assert.equal(big.length, 1);
  assert.equal(big[0].installable, true);
});

test('pool: personal, claude.ai, enabled plugin and built-in items are listed only as already active, never as candidates, never copied', () => {
  const w = world();
  w.project('me', { make: unityAt });
  w.project('other', { make: (d) => (unityAt(d), skillAt(d, 'unity-debug', 'Unity debugging'), skillAt(d, 'unity-mine', 'Unity')) });
  w.active('skill', 'unity-debug', 'Unity debugging', 'personal');
  w.active('skill', 'unity:ui-toolkit', 'UI Toolkit panels', 'plugin', { plugin: 'unity@market' });
  w.active('skill', 'react-hooks', 'React hooks', 'claudeai');
  w.active('agent', 'Explore', 'Read-only search agent', 'builtin');
  w.roster.set('skill:disabled-unity', { kind: 'skill', name: 'disabled-unity', source: 'plugin', sources: ['plugin'], installedIn: [], global: false, description: 'Unity' });
  const body = createFit({ catalog: w.catalog }).get('me').body;
  assert.deepEqual(keys(body.candidates), ['skill:unity-mine'], 'a candidate with the name of an active item is not offered again');
  assert.deepEqual(body.active.map((a) => `${a.key}<${a.source}`), ['skill:unity-debug<personal', 'skill:unity:ui-toolkit<plugin']);
  assert.equal(body.active[1].plugin, 'unity@market');
  assert.ok(!body.active.some((a) => a.name === 'react-hooks'), 'an active item that conflicts is not listed');
  assert.ok(!body.active.some((a) => a.name === 'disabled-unity'), 'a disabled plugin is not active');
});

test('pool: a broad project, a tool folder that is a junction, the personal .claude and an invalid name are never read as candidates', () => {
  const w = world();
  w.project('me', { make: unityAt });
  const src = path.join(w.base, 'elsewhere');
  skillAt(src, 'unity-linked', 'Unity linked');
  w.project('linked', { make: (d) => (unityAt(d), junction(path.join(src, '.claude'), path.join(d, '.claude'))) });
  w.project('linked-group', { make: (d) => (unityAt(d), junction(path.join(src, '.claude', 'skills'), path.join(d, '.claude', 'skills'))) });
  w.project('bad', { make: (d) => (unityAt(d), skillAt(d, 'Unity Helper', 'Unity'), agentAt(d, 'con', 'Unity')) });
  const broad = w.project('broad', { make: (d) => skillAt(d, 'unity-broad', 'Unity') });
  w.projects.find((p) => p.id === 'broad').broad = true;
  skillAt(HOME, 'unity-personal', 'Unity personal');
  w.projects.push({ id: 'home', name: 'home', kind: 'adhoc', path: HOME, exists: true, via: [] });
  const body = createFit({ catalog: w.catalog }).get('me').body;
  assert.deepEqual(keys(body.candidates), []);
  assert.ok(broad);
  // readProjectItems itself: links inside a skills folder are skipped
  const d = path.join(w.base, 'inner');
  skillAt(d, 'real-skill', 'x');
  junction(path.join(src, '.claude', 'skills', 'unity-linked'), path.join(d, '.claude', 'skills', 'linked-skill'));
  assert.deepEqual(readProjectItems(d).map((i) => i.name), ['real-skill']);
  assert.deepEqual(readProjectItems(HOME, { claudeDir: CLAUDE }), [], 'the personal folder is never a project tool folder');
});

// ---------------- scoring (§2.3–§2.5) ----------------
const prof = (tags) => {
  const s = new Set(withImplied(tags));
  return { stacks: new Set([...s].filter((t) => TAG_BY_ID.get(t).type === 'stack')), primary: primaryStacks(s), topics: new Set([...s].filter((t) => TAG_BY_ID.get(t).type === 'topic')) };
};

test('scoring: a shared stack +5, a topic the project shows +2, installed in a project sharing a stack +3, used there +2; at most two reasons, strongest first', () => {
  const unity = prof(['unity', 'multiplayer']);
  const q = { id: 'q', primary: new Set(['unity']) };
  const web = { id: 'web', primary: new Set(['nextjs']) };
  assert.equal(SCORE.stack, 5);
  assert.equal(SCORE.topic, 2);
  assert.equal(SCORE.installedIn, 3);
  assert.equal(SCORE.usedIn, 2);
  assert.deepEqual(scoreItem(['unity'], unity), { excluded: false, stacks: ['unity'], score: 5, confidence: 'medium', reasons: ['stack:unity'] });
  assert.equal(scoreItem(['unity', 'gamedev'], unity).score, 7);
  assert.equal(scoreItem(['unity', 'gamedev', 'multiplayer'], unity).score, 9);
  assert.equal(scoreItem(['unity', 'docs'], unity).score, 5, 'a topic the project does not show adds nothing');
  assert.equal(scoreItem(['unity'], unity, { installedIn: [q] }).score, 8);
  assert.equal(scoreItem(['unity'], unity, { installedIn: [web] }).score, 5, 'a project that shares no stack adds nothing');
  assert.equal(scoreItem(['unity'], unity, { installedIn: [q, q] }).score, 8, '+3 once');
  assert.equal(scoreItem(['unity'], unity, { usedIn: [q] }).score, 7);
  const all = scoreItem(['unity', 'gamedev', 'multiplayer'], unity, { installedIn: [web, q], usedIn: [q] });
  assert.equal(all.score, 5 + 2 + 2 + 3 + 2);
  assert.deepEqual(all.reasons, ['stack:unity', 'installed-in:q']);
  assert.deepEqual(scoreItem(['gamedev', 'multiplayer'], unity, { usedIn: [q] }).reasons, ['used-in:q', 'topic:gamedev']);
});

test('scoring: conflict exclusion — an item whose stacks the project lacks entirely is excluded; one shared stack keeps it; an item without stack tags is never excluded', () => {
  const unity = prof(['unity']);
  for (const tags of [['react-native'], ['react-native', 'expo'], ['nextjs'], ['react', 'typescript'], ['godot'], ['unreal'], ['dotnet', 'csharp'], ['python']]) {
    const s = scoreItem(tags, unity);
    assert.equal(s.excluded, true, tags.join(','));
    assert.equal(s.score, 0);
  }
  assert.equal(scoreItem(['unity', 'unreal', 'godot'], unity).excluded, false, 'a multi-engine item that includes Unity');
  assert.equal(scoreItem(['testing', 'docs'], unity).excluded, false);
  assert.equal(scoreItem([], unity).excluded, false);
  assert.equal(scoreItem(['csharp'], unity).excluded, false, 'a language the project has (implied by Unity)');
  // A language list that names GDScript next to C# is not a Godot-only item
  const langs = itemTags({ name: 'game-programming-languages', description: 'Game programming languages - C#, C++, GDScript.' });
  assert.deepEqual(langs, ['csharp', 'cpp', 'gdscript', 'gamedev']);
  assert.equal(scoreItem(langs, unity).excluded, false);
  assert.equal(scoreItem(itemTags({ name: 'godot-4', description: 'Godot 4 and GDScript' }), unity).excluded, true);
  // A project without any stack: every item with a stack is excluded
  assert.equal(scoreItem(['unity'], prof([])).excluded, true);
  assert.equal(scoreItem(['docs'], prof(['docs'])).excluded, false);
});

test('scoring: confidence — high needs a shared primary stack and a score of at least 8; medium at least 4; otherwise low', () => {
  const unity = prof(['unity', 'multiplayer', 'python']);
  const q = { id: 'q', primary: new Set(['unity']) };
  assert.equal(HIGH_SCORE, 8);
  assert.equal(MEDIUM_SCORE, 4);
  assert.equal(scoreItem(['unity', 'gamedev'], unity).confidence, 'medium', '7');
  assert.equal(scoreItem(['unity'], unity, { installedIn: [q] }).confidence, 'high', '8 with a shared primary stack');
  assert.equal(scoreItem(['gamedev', 'multiplayer'], unity, { installedIn: [q], usedIn: [q] }).confidence, 'medium', '9 without any stack');
  assert.equal(scoreItem(['python'], unity, { installedIn: [q] }).confidence, 'medium', '8, but python is not the primary stack of a Unity project');
  assert.equal(scoreItem(['gamedev', 'multiplayer'], unity).confidence, 'medium', '4');
  assert.equal(scoreItem(['multiplayer'], unity).confidence, 'low', '2');
  assert.equal(scoreItem(['docs'], unity).confidence, 'low', '0');
});

test('selection: every high candidate, at most 4 skills and 1 agent (a newcomer can weigh that many), highest score first; one per name; installed or not installable never', () => {
  assert.deepEqual({ ...SELECT_CAPS }, { skill: 4, agent: 1 });
  const cand = (kind, name, score, extra = {}) => ({ key: `${kind}:${name}${extra.label ? '@' + extra.label : ''}`, kind, name, score, confidence: 'high', installable: true, installed: false, sources: ['library'], ...extra });
  const list = [];
  for (let i = 0; i < 12; i++) list.push(cand('skill', `s${String(i).padStart(2, '0')}`, 8 + i));
  for (let i = 0; i < 7; i++) list.push(cand('agent', `a${i}`, 8 + i));
  list.push(cand('skill', 'top-installed', 99, { installed: true }), cand('skill', 'top-blocked', 98, { installable: false }), cand('skill', 'mid', 50, { confidence: 'medium' }));
  list.push(cand('skill', 'twin', 40, { label: 'x' }), cand('skill', 'twin', 40, { label: 'y' }));
  const sel = autoSelect(list);
  const skills = [...sel].filter((k) => k.startsWith('skill:'));
  const agents = [...sel].filter((k) => k.startsWith('agent:'));
  assert.equal(skills.length, 4);
  assert.equal(agents.length, 1);
  assert.deepEqual(skills, ['skill:twin@x', 'skill:s11', 'skill:s10', 'skill:s09']);
  assert.deepEqual(agents, ['agent:a6']);
  assert.deepEqual([...autoSelect([...list].reverse())], [...sel], 'independent of the input order');
  // Found only in another project: never selected unseen, however strong; the kit counts like the library
  assert.deepEqual([...autoSelect([cand('skill', 'far', 99, { sources: ['project:demo'] }), cand('skill', 'kit-one', 10, { sources: ['kit'] })])], ['skill:kit-one']);
  // byFit: band, then score, skills before agents, then name
  assert.deepEqual([cand('agent', 'b', 9), cand('skill', 'c', 9), cand('skill', 'a', 3, { confidence: 'low' }), cand('skill', 'd', 5, { confidence: 'medium' })].sort(byFit).map((c) => c.name), ['c', 'b', 'd', 'a']);
});

test('determinism: the same computer gives the same fit whatever the order of projects, library folders and roster', () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-z', 'Unity Z');
  libSkill(w.hub, 'web', 'unity-a', 'Unity A for UI');
  w.project('me', { make: unityAt });
  w.project('b', { make: (d) => (unityAt(d), skillAt(d, 'unity-m', 'Unity M'), agentAt(d, 'unity-agent', 'Unity')) });
  w.project('a', { make: (d) => (unityAt(d), skillAt(d, 'unity-m', 'Unity M'), skillAt(d, 'rn', 'React Native')) });
  w.active('skill', 'unity-helper', 'Unity helper');
  const first = createFit({ catalog: w.catalog, ingest: usage({ 'unity-m': ['a'] }) }).get('me').body;
  w.projects.reverse();
  w.catalog.roster = new Map([...w.roster].reverse());
  const second = createFit({ catalog: w.catalog, ingest: usage({ 'unity-m': ['a'] }) }).get('me').body;
  assert.deepEqual(second, first);
  assert.deepEqual(keys(first.candidates), ['skill:unity-m', 'agent:unity-agent', 'skill:unity-a', 'skill:unity-z']);
});

// ---------------- the fit cache (§3) ----------------
test('fit cache: a second request comes from the cache; a change in the project folder, the library, the roster or the usage computes it again; invalidate() drops it', async () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-a', 'Unity A');
  const me = w.project('me', { make: unityAt });
  w.project('q', { make: (d) => (unityAt(d), skillAt(d, 'unity-q', 'Unity Q')) });
  const ing = usage();
  let clock = 1000;
  const fit = createFit({ catalog: w.catalog, ingest: ing, now: () => clock });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const step = (label, expectComputed) => {
    const before = fit.stats.computed;
    const body = fit.get('me').body;
    assert.equal(fit.stats.computed - before, expectComputed ? 1 : 0, label);
    return body;
  };
  step('first', true);
  step('cached', false);
  step('cached again', false);
  // The project folder: a new file in a folder the census read
  await tick();
  write(path.join(me, 'Assets', 'Scripts', 'Net.cs'), 'x');
  step('project folder changed', true);
  step('cached', false);
  // The library: a hand-added skill, seen once the library's signature is read again (at most LIBRARY_SIG_MS later)
  libSkill(w.hub, 'game', 'unity-b', 'Unity B');
  step('library read again only after a while', false);
  clock += LIBRARY_SIG_MS;
  assert.ok(byKey(step('library changed', true), 'skill:unity-b'));
  step('cached', false);
  // The roster: the catalog reloaded with a change
  w.roster.set('skill:unity-q', { kind: 'skill', name: 'unity-q', source: 'project', sources: ['project'], installedIn: ['me'], global: false });
  w.bump();
  assert.equal(byKey(step('roster changed', true), 'skill:unity-q').installed, true);
  // A reload without a change (same content, new version) is not a change of the roster... but a new Map is checked
  w.bump();
  step('roster reloaded, same content', false);
  // The usage: a skill used in another project
  ing.usage.skills.set('unity-b', { projects: new Set(['q']) });
  step('usage changed', true);
  step('cached', false);
  // The install record
  write(path.join(w.hub, 'registry', 'installs.json'), JSON.stringify({ version: 1, installs: [] }));
  clock += LIBRARY_SIG_MS; // part of the library's signature (the actions call invalidate() at once after an install)
  step('install record changed', true);
  fit.invalidate('me');
  step('invalidated', true);
  fit.invalidate();
  step('all invalidated', true);
  assert.equal(fit.get('nope').status, 404);
});

// ---------------- the Unity case (§ user request) ----------------
test('Unity project: Unity skills come first with high confidence and reasons; React Native and Next.js skills are never listed', () => {
  const w = world();
  libSkill(w.hub, 'mobile', 'react-native-expert', 'React Native and Expo apps');
  libSkill(w.hub, 'web', 'nextjs-16', 'Next.js 16 App Router');
  libSkill(w.hub, 'docs', 'writing', 'Technical writing');
  w.project('arena', { make: (d) => (unityAt(path.join(d, 'Arena Demo')), write(path.join(d, 'Arena Demo', 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.firstgeargames.fishnet': 'x' } }))) });
  w.project('demo', {
    make: (d) => {
      unityAt(d);
      for (const n of ['unity-multiplayer', 'unity-ui-toolkit', 'unity-save-system', 'unity-addressables']) skillAt(d, n, `Unity ${n.slice(6)} patterns`);
      skillAt(d, 'react-native', 'React Native mobile apps with Expo');
      skillAt(d, 'flutter-mobile', 'Flutter apps');
      skillAt(d, 'golang-pro', 'Go services');
      skillAt(d, 'code-review', 'Review code changes');
      agentAt(d, 'unity-specialist', 'Unity engine specialist');
      agentAt(d, 'godot-specialist', 'Godot 4 specialist');
    },
  });
  w.project('shop', { kind: 'adhoc', make: (d) => (rnAt(path.join(d, 'apps', 'mobile')), skillAt(d, 'expo-router', 'Expo Router navigation'), skillAt(d, 'nextjs-seo', 'Next.js SEO'), agentAt(d, 'mobile-dev', 'React Native developer')) });
  const body = createFit({ catalog: w.catalog, ingest: usage({ 'unity-multiplayer': ['demo'] }) }).get('arena').body;
  assert.ok(body.project.tags.some((t) => t.id === 'unity' && t.from === 'Arena Demo/Assets, ProjectSettings'));
  const high = body.candidates.filter((c) => c.confidence === 'high');
  assert.deepEqual(keys(high), ['skill:unity-multiplayer', 'skill:unity-addressables', 'skill:unity-save-system', 'skill:unity-ui-toolkit', 'agent:unity-specialist']);
  assert.deepEqual(byKey(body, 'skill:unity-multiplayer').reasons, ['stack:unity', 'installed-in:demo']);
  const own = (c) => c.sources.includes('library') || c.sources.includes('kit');
  assert.ok(high.every((c) => c.selected === own(c)), 'the strong ones from the library or the kit; those only in other projects wait for the switch');
  const names = body.candidates.map((c) => c.name);
  for (const n of ['react-native-expert', 'nextjs-16', 'react-native', 'flutter-mobile', 'golang-pro', 'expo-router', 'nextjs-seo', 'mobile-dev', 'godot-specialist']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('code-review') && names.includes('writing'), 'items without a stack stay (lower)');
  assert.equal(body.excluded.count, 9);
  assert.deepEqual(body.selection, { skills: high.filter((c) => own(c) && c.kind === 'skill').length, agents: high.filter((c) => own(c) && c.kind === 'agent').length });
});

// ---------------- GET /api/projects/<id>/fit ----------------
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/projects/<id>/fit: read-only, no action mode needed; the usual access rules; unknown or malformed ids; nothing written', async () => {
  const w = world();
  libSkill(w.hub, 'game', 'unity-a', 'Unity A');
  w.project('me', { make: unityAt });
  const before = snapshotTree(w.base);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions: { mode: 'off' } }));
  try {
    const r = await get(port, '/api/projects/me/fit', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.project.id, 'me');
    assert.deepEqual(keys(r.json.candidates), ['skill:unity-a']);
    assert.deepEqual(Object.keys(r.json).sort(), ['active', 'candidates', 'excluded', 'project', 'selection']);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal((await get(port, '/api/projects/nope/fit', { 'Sec-Fetch-Site': 'same-origin' })).status, 404);
    assert.equal((await get(port, '/api/projects/me/fit', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 403);
    assert.equal((await get(port, '/api/projects/me/fit', { Host: `evil.example:${port}` })).status, 421);
    for (const bad of ['/api/projects/-me/fit', '/api/projects/a%2F..%2Fb/fit', '/api/projects/me/fit/x', '/api/projects//fit']) assert.equal((await get(port, bad, { 'Sec-Fetch-Site': 'same-origin' })).status, 404, bad);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(snapshotTree(w.base), before, 'nothing written');
  // No hub or a legacy hub: the fit is listed, nothing is installable
  const noHub = createFit({ catalog: { ...w.catalog, hubDir: null }, hubDir: null }).get('me').body;
  assert.equal(noHub.problem, 'no-hub');
  const legacy = world({ legacy: true });
  legacy.project('me', { make: (d) => (unityAt(d), skillAt(d, 'x', 'y')) });
  legacy.project('q', { make: (d) => (unityAt(d), skillAt(d, 'unity-q', 'Unity Q')) });
  const lb = createFit({ catalog: legacy.catalog }).get('me').body;
  assert.equal(lb.problem, 'legacy-hub');
  assert.ok(lb.candidates.length && lb.candidates.every((c) => !c.installable && !c.selected));
  // A broad project folder: nothing is read, nothing installable
  w.projects.find((p) => p.id === 'me').broad = true;
  w.bump();
  const broad = createFit({ catalog: w.catalog }).get('me').body;
  assert.equal(broad.problem, 'broad-folder');
  assert.ok(broad.candidates.every((c) => !c.installable));
});

// ---------------- skills-apply (§3) ----------------
function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`no answer: ${method} ${p}`)));
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

async function startServer(w, { mode = 'live', ...over } = {}) {
  const spawnCalls = [];
  const logs = [];
  let changes = 0;
  let clock = Date.UTC(2026, 8, 28, 10, 0, 0, 123);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const workDir = path.join(w.base, 'app');
  fs.mkdirSync(workDir, { recursive: true });
  const fit = createFit({ catalog: w.catalog, ingest: over.ingest || usage() });
  const actions = createActions({ catalog: w.catalog, ingest: { sessions: new Map() }, mode, port, hubDir: w.hub, workDir, homeDir: HOME, claudeDir: CLAUDE, spawn: fakeSpawn(spawnCalls), now: () => clock, log: (l) => logs.push(l), onChange: () => changes++, fit, ...over });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions, fit }));
  const headers = { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': actions.token || '' };
  return {
    port,
    fit,
    actions,
    spawnCalls,
    logs,
    changes: () => changes,
    tick: (ms = 3000) => (clock += ms),
    post: (body, h = {}) => request(port, { method: 'POST', path: '/api/action', body, headers: { ...headers, ...h } }),
    getFit: (id) => request(port, { path: `/api/projects/${id}/fit`, headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

const ops = (plan) => plan.map((e) => `${e.op}:${e.kind}:${e.name}${e.target ? '@' + e.target : ''}:${e.reason}`);

// A Unity project 'me', a library Unity skill, and another Unity project with a skill and an agent the library lacks
function applyWorld() {
  const w = world();
  libSkill(w.hub, 'game', 'unity-lib', 'Unity library skill for UI');
  write(path.join(w.lib, 'game', 'skills', 'unity-lib', 'scripts', 'run.txt'), 'echo lib');
  libSkill(w.hub, 'web', 'nextjs-lib', 'Next.js pages');
  w.project('me', { make: unityAt });
  w.project('demo', {
    make: (d) => {
      unityAt(d);
      skillAt(d, 'unity-net', 'Unity netcode');
      write(path.join(d, '.claude', 'skills', 'unity-net', 'references', 'notes.md'), '# notes');
      agentAt(d, 'unity-pro', 'Unity specialist');
      skillAt(d, 'rn-skill', 'React Native');
    },
  });
  // The library skill is installed in demo too (so it is high for me)
  fs.cpSync(path.join(w.lib, 'game', 'skills', 'unity-lib'), path.join(w.dir('demo'), '.claude', 'skills', 'unity-lib'), { recursive: true });
  return w;
}

test('skills-apply dry: the chosen keys planned as imports then installs; nothing is written; the reply says applied false, reason preview-mode', async () => {
  const w = applyWorld();
  const env = await startServer(w, { mode: 'dry' });
  const before = snapshotTree(w.base);
  try {
    const f = await env.getFit('me');
    // The automatic selection takes only what is in the library or the kit: items found only in another project wait
    // behind "also from my other projects" (docs/direction.md §3.2)
    assert.deepEqual(f.json.candidates.filter((c) => c.selected).map((c) => c.key), ['skill:unity-lib']);
    const r = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-lib', 'skill:unity-net', 'agent:unity-pro'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mode, 'dry');
    assert.equal(r.json.applied, false);
    assert.equal(r.json.reason, 'preview-mode');
    assert.equal(r.json.selection, 'keys');
    assert.deepEqual(r.json.targets, ['claude']);
    assert.deepEqual(r.json.result, { executed: false, imported: 0, copied: 0, updated: 0 });
    assert.deepEqual(ops(r.json.plan), ['import:skill:unity-net:new', 'import:agent:unity-pro:new', 'copy:skill:unity-lib@claude:new', 'copy:skill:unity-net@claude:new', 'copy:agent:unity-pro@claude:new']);
    const imp = r.json.plan[0];
    assert.equal(imp.from, 'project:demo');
    assert.equal(imp.category, 'game');
    assert.equal(imp.path, path.join(w.lib, 'game', 'skills', 'unity-net'));
    assert.ok(r.json.plan.every((e) => !Object.keys(e).some((k) => k.startsWith('_'))), 'no internal field');
    assert.equal(env.changes(), 0);
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')), 'dry wrote nothing');
});

test('skills-apply live: imports into the library, then installs into the project; the record names the library copy; catalog.json regenerated; the fit follows', async () => {
  const w = applyWorld();
  const env = await startServer(w);
  const me = w.dir('me');
  try {
    const r = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-lib', 'skill:unity-net', 'agent:unity-pro'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.mode, 'live');
    assert.equal(r.json.applied, true);
    assert.ok(!('reason' in r.json));
    assert.deepEqual(r.json.result, { executed: true, imported: 2, copied: 3, updated: 0, catalogError: false });
    assert.deepEqual(ops(r.json.plan), ['import:skill:unity-net:new', 'import:agent:unity-pro:new', 'copy:skill:unity-lib@claude:new', 'copy:skill:unity-net@claude:new', 'copy:agent:unity-pro@claude:new']);
    // Library copies (whole skill folder) and the project copies
    assert.equal(fs.readFileSync(path.join(w.lib, 'game', 'skills', 'unity-net', 'references', 'notes.md'), 'utf8'), '# notes');
    assert.ok(exists(path.join(w.lib, 'game', 'agents', 'unity-pro.md')));
    assert.equal(fs.readFileSync(path.join(me, '.claude', 'skills', 'unity-lib', 'scripts', 'run.txt'), 'utf8'), 'echo lib');
    assert.ok(exists(path.join(me, '.claude', 'skills', 'unity-net', 'references', 'notes.md')));
    assert.ok(exists(path.join(me, '.claude', 'agents', 'unity-pro.md')));
    assert.ok(!exists(path.join(me, '.claude', 'skills', 'rn-skill')));
    const cat = JSON.parse(fs.readFileSync(path.join(w.lib, 'catalog.json'), 'utf8'));
    assert.ok(cat.items.some((i) => i.name === 'unity-net' && i.category === 'game'));
    const rec = readInstalls(w.hub).installs;
    assert.deepEqual(rec.map((x) => `${x.kind}:${x.name}<${x.source}`).sort(), ['agent:unity-pro<library/game/agents/unity-pro.md', 'skill:unity-lib<library/game/skills/unity-lib', 'skill:unity-net<library/game/skills/unity-net']);
    assert.equal(rec.find((x) => x.name === 'unity-net').hash, treeHash(path.join(me, '.claude', 'skills', 'unity-net')));
    assert.equal(env.changes(), 1, 'one reload for the whole operation');
    // The fit follows at once: the items are installed now and nothing is selected
    const f = await env.getFit('me');
    assert.ok(f.json.candidates.filter((c) => ['unity-lib', 'unity-net', 'unity-pro'].includes(c.name)).every((c) => c.installed && !c.selected));
    assert.deepEqual(f.json.selection, { skills: 0, agents: 0 });
    // Again: nothing selected, nothing written
    env.tick();
    const again = await env.post({ action: 'skills-apply', projectId: 'me' });
    assert.equal(again.json.applied, false);
    assert.equal(again.json.reason, 'nothing-selected');
    // The same keys again: already installed
    env.tick();
    const same = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-net'] });
    assert.deepEqual(ops(same.json.plan), ['skip:skill:unity-net:installed']);
    assert.equal(same.json.reason, 'nothing-to-do');
  } finally {
    await env.close();
  }
});

test('skills-apply live: a failed import skips only its own item; the others are imported and installed', async () => {
  const w = applyWorld();
  // A second project-only Unity skill over the file limit (never measured by the fit: it is alone), and one whose
  // source disappears after the fit was computed
  const demo = w.dir('demo');
  for (let i = 0; i < 501; i++) write(path.join(demo, '.claude', 'skills', 'unity-huge', 'f', `${i}.txt`));
  skillAt(demo, 'unity-huge', 'Unity huge');
  skillAt(demo, 'unity-gone', 'Unity gone soon');
  const env = await startServer(w);
  try {
    const f = await env.getFit('me');
    assert.ok(byKey(f.json, 'skill:unity-huge').installable && byKey(f.json, 'skill:unity-gone').installable);
    assert.ok(!byKey(f.json, 'skill:unity-huge').selected, 'only in another project: never selected unseen');
    fs.rmSync(path.join(demo, '.claude', 'skills', 'unity-gone'), { recursive: true });
    const r = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-huge', 'skill:unity-gone', 'skill:unity-net', 'skill:unity-lib'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.selection, 'keys');
    assert.deepEqual(ops(r.json.plan), ['skip:skill:unity-huge:too-many-files', 'skip:skill:unity-gone:source-missing', 'import:skill:unity-net:new', 'copy:skill:unity-net@claude:new', 'copy:skill:unity-lib@claude:new']);
    assert.equal(r.json.applied, true);
    assert.deepEqual(r.json.result, { executed: true, imported: 1, copied: 2, updated: 0, catalogError: false });
    assert.ok(!exists(path.join(w.lib, 'game', 'skills', 'unity-huge')));
    assert.ok(!exists(path.join(w.dir('me'), '.claude', 'skills', 'unity-huge')));
    assert.ok(exists(path.join(w.dir('me'), '.claude', 'skills', 'unity-net')));
  } finally {
    await env.close();
  }
});

test('skills-apply: chosen keys; an unknown key, a duplicate, an installed or blocked item is skipped with a reason; body checks come first (400)', async () => {
  const w = applyWorld();
  skillAt(w.dir('me'), 'unity-own', 'Unity mine');
  skillAt(w.dir('demo'), 'unity-own', 'Unity other');
  const env = await startServer(w, { mode: 'dry' });
  try {
    const r = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-lib', 'skill:no-such', 'skill:unity-lib', 'skill:unity-own', 'agent:unity-pro'], targets: ['claude', 'agents'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.targets, ['claude', 'agents']);
    assert.deepEqual(ops(r.json.plan), ['skip:skill:no-such:not-a-candidate', 'skip:skill:unity-own:installed', 'import:agent:unity-pro:new', 'copy:skill:unity-lib@claude:new', 'copy:skill:unity-lib@agents:new', 'copy:agent:unity-pro@claude:new']);
    const cases = [
      [{ action: 'skills-apply' }, 'missing-field'],
      [{ action: 'skills-apply', projectId: 'me', items: [{ kind: 'skill', name: 'a' }] }, 'unexpected-field'],
      [{ action: 'skills-apply', projectId: 'me', keys: [] }, 'bad-keys'],
      [{ action: 'skills-apply', projectId: 'me', keys: 'skill:a' }, 'bad-keys'],
      [{ action: 'skills-apply', projectId: 'me', keys: ['plugin:a'] }, 'bad-keys'],
      [{ action: 'skills-apply', projectId: 'me', keys: ['skill:../x'] }, 'bad-keys'],
      [{ action: 'skills-apply', projectId: 'me', keys: ['skill:con'] }, 'bad-name'],
      [{ action: 'skills-apply', projectId: 'me', keys: [7] }, 'bad-keys'],
      [{ action: 'skills-apply', projectId: 'me', keys: Array.from({ length: 26 }, (_, i) => `skill:s${i}`) }, 'too-many-items'],
      [{ action: 'skills-apply', projectId: 'me', targets: ['global'] }, 'bad-targets'],
      [{ action: 'skills-apply', projectId: '-me' }, 'bad-project-id'],
    ];
    for (const [b, error] of cases) {
      env.tick();
      const x = await env.post(b);
      assert.equal(x.status, 400, JSON.stringify(b));
      assert.equal(x.json.error, error, JSON.stringify(b));
    }
    assert.ok(SKILL_ACTIONS.includes('skills-apply'));
    // A repeated key is sent once; two variants of one name: the second is skipped as a duplicate
    assert.equal(r.json.plan.filter((e) => e.name === 'unity-lib').length, 2, 'one per target, not per repeated key');
    const variant = (label) => ({ key: `skill:twin@${label}`, kind: 'skill', name: 'twin', installable: true, installed: false, _lib: { path: 'x' } });
    const fake = { candidates: [], _byKey: new Map([['skill:twin@a', variant('a')], ['skill:twin@b', variant('b')]]) };
    const part = planApplyImports({ fit: fake, keys: ['skill:twin@a', 'skill:twin@b'], hubDir: w.hub });
    assert.deepEqual(part.entries.map((e) => `${e.key}:${e.reason}`), ['skill:twin@b:duplicate']);
    assert.deepEqual(part.installItems, [{ kind: 'skill', name: 'twin' }]);
  } finally {
    await env.close();
  }
});

test('skills-apply: one writing action at a time — while a live trial holds the lock, skills-apply gets 409 busy and writes nothing; afterwards it runs', async () => {
  const w = applyWorld();
  let release;
  const gate = new Promise((r) => (release = r));
  const slowSpawn = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    gate.then(() => child.emit('spawn'));
    return child;
  };
  libSkill(w.hub, 'game', 'trial-skill', 'x');
  const env = await startServer(w, { spawn: slowSpawn });
  try {
    const first = env.post({ action: 'skills-trial', projectId: 'me', items: [{ kind: 'skill', name: 'trial-skill' }] });
    await new Promise((r) => setTimeout(r, 100));
    const second = await env.post({ action: 'skills-apply', projectId: 'me' });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'busy');
    assert.ok(!exists(path.join(w.dir('me'), '.claude')), 'nothing installed while busy');
    release();
    assert.equal((await first).status, 200);
    env.tick();
    const third = await env.post({ action: 'skills-apply', projectId: 'me' });
    assert.equal(third.status, 200);
    assert.equal(third.json.applied, true);
  } finally {
    await env.close();
  }
});

test('skills-apply: every existing safety rule holds — off 404, token/Origin/Sec-Fetch-Site 403, legacy hub 409, no hub 404, broad folder 409, project-owned never overwritten, a reparse point on the way refused', async () => {
  const w = applyWorld();
  const me = w.dir('me');
  const before = snapshotTree(w.base);
  const off = await startServer(w, { mode: 'off' });
  try {
    const r = await off.post({ action: 'skills-apply', projectId: 'me' }, { 'X-SiberSentez-Token': 'a'.repeat(64) });
    assert.equal(r.status, 404);
  } finally {
    await off.close();
  }
  const env = await startServer(w);
  try {
    const body = { action: 'skills-apply', projectId: 'me' };
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': 'b'.repeat(64) })).status, 403);
    assert.equal((await env.post(body, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await env.post(body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await env.post(body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')), 'a refused request writes nothing');
    // Broad folder
    w.projects.push({ id: 'wide', name: 'wide', kind: 'adhoc', path: HOME, exists: true, broad: true, via: [] });
    const b = await env.post({ action: 'skills-apply', projectId: 'wide' });
    assert.equal(b.status, 409);
    assert.equal(b.json.error, 'broad-folder');
    // Project-owned: a folder with the name of a candidate that SiberSentez did not install is never overwritten
    write(path.join(me, '.claude', 'skills', 'unity-lib', 'SKILL.md'), 'mine');
    w.bump();
    env.tick();
    const own = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-net'] });
    assert.equal(own.status, 200);
    // A reparse point on the way: the agents folder of the project is a junction
    const elsewhere = path.join(w.base, 'elsewhere-agents');
    fs.mkdirSync(elsewhere, { recursive: true });
    junction(elsewhere, path.join(me, '.claude', 'agents'));
    env.tick();
    const rp = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['agent:unity-pro'] });
    assert.deepEqual(ops(rp.json.plan), ['import:agent:unity-pro:new', 'skip:agent:unity-pro@claude:reparse-point']);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing written through the junction');
    assert.equal(fs.readFileSync(path.join(me, '.claude', 'skills', 'unity-lib', 'SKILL.md'), 'utf8'), 'mine', 'project-owned untouched');
    env.tick();
    const direct = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-lib'] });
    assert.deepEqual(ops(direct.json.plan), ['skip:skill:unity-lib:installed'], 'the fit already knows the project has it');
  } finally {
    await env.close();
  }
  // Legacy hub and no hub
  const lw = world({ legacy: true });
  lw.project('me', { make: unityAt });
  const lenv = await startServer(lw);
  try {
    const r = await lenv.post({ action: 'skills-apply', projectId: 'me' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'legacy-hub');
  } finally {
    await lenv.close();
  }
  const nenv = await startServer(w, { hubDir: null });
  try {
    const r = await nenv.post({ action: 'skills-apply', projectId: 'me' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'no-hub');
  } finally {
    await nenv.close();
  }
});

test('skills-apply: a planned install never overwrites what the project owns, even with a stale fit (the plan checks the disk again)', async () => {
  for (const mode of ['dry', 'live']) {
    const w = applyWorld();
    const env = await startServer(w, { mode });
    try {
      // A fit computed before the user added a folder with that name by hand, served as if nothing changed
      const stale = env.fit.fitOf('me');
      assert.equal(stale.fit._byKey.get('skill:unity-lib').installed, false);
      write(path.join(w.dir('me'), '.claude', 'skills', 'unity-lib', 'SKILL.md'), 'mine');
      env.fit.fitOf = () => stale;
      const r = await env.post({ action: 'skills-apply', projectId: 'me', keys: ['skill:unity-lib'] });
      assert.deepEqual(ops(r.json.plan), ['skip:skill:unity-lib@claude:project-owned'], mode);
      assert.equal(r.json.applied, false);
      assert.equal(fs.readFileSync(path.join(w.dir('me'), '.claude', 'skills', 'unity-lib', 'SKILL.md'), 'utf8'), 'mine');
    } finally {
      await env.close();
    }
  }
});

test('fit cache: an item added by hand to the project tool folders is seen at once (the tool folders are part of the fingerprint)', () => {
  const w = applyWorld();
  const fit = createFit({ catalog: w.catalog });
  fs.mkdirSync(path.join(w.dir('me'), '.claude', 'skills'), { recursive: true });
  assert.equal(byKey(fit.get('me').body, 'skill:unity-lib').installed, false);
  write(path.join(w.dir('me'), '.claude', 'skills', 'unity-lib', 'SKILL.md'), 'mine');
  assert.equal(byKey(fit.get('me').body, 'skill:unity-lib').installed, true);
  assert.equal(fit.stats.computed, 2);
});

test('a project folder that is gone and comes back: its fingerprint changes, so the fit is computed again', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-gone-'));
  const dir = path.join(base, 'proje');
  try {
    const gone = projectProfile({ id: 'g', kind: 'discovered', path: dir });
    assert.deepEqual(gone.folders[0], { abs: dir, mtimeMs: -1 }, 'the missing folder is in the fingerprint');
    fs.mkdirSync(dir);
    const back = projectProfile({ id: 'g', kind: 'discovered', path: dir });
    assert.notEqual(back.folders[0].mtimeMs, -1);
    assert.notEqual(fs.lstatSync(dir).mtimeMs, gone.folders[0].mtimeMs, 'what foldersUnchanged compares has changed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a writing project (a novel, a webtoon, a script) is tagged content from its folders, and the Building seats it in the library', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sibersentez-novel-'));
  try {
    for (const rel of ['novel/chapters', 'novel/characters', 'research']) fs.mkdirSync(path.join(dir, ...rel.split('/')), { recursive: true });
    fs.writeFileSync(path.join(dir, 'novel', 'chapters', 'ch01.md'), '# Bölüm 1');
    const tags = censusTags(census(dir));
    assert.equal(tags.get('content'), 'novel/', 'the evidence is the first folder');
    const { projectRoomKind } = await import('../public/js/hq-scene.js');
    assert.equal(projectRoomKind([...tags].map(([id, from]) => ({ id, from }))), 'library');
    assert.equal(projectRoomKind([{ id: 'content', from: 'novel/' }, { id: 'typescript', from: '*.ts x9' }]), 'dev', 'code wins: a site with a blog is software');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
