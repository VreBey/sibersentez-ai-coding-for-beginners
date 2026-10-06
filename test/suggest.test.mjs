// Suggestion tests (docs/skills-flow.md §3.1, §6): each project signal, the ranking, installed items marked, registry
// packages, and the read-only endpoint. Run: node --test test/suggest.test.mjs
// Hermetic: a fake hub and fake projects under the system temp folder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { initHub } from '../server/hub.mjs';
import { projectSignals, registrySignals, rankItems, projectSuggestions, NPM_SIGNALS, MAX_SUGGESTIONS } from '../server/suggest.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-suggest-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n`;
let n = 0;
const project = (files = {}, dirs = []) => {
  const dir = path.join(ROOT, `p${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, ...rel.split('/')), text);
  for (const d of dirs) fs.mkdirSync(path.join(dir, ...d.split('/')), { recursive: true });
  return dir;
};
const ids = (dir) => projectSignals(dir).map((s) => `${s.id}<${s.from}`);
const pkg = (deps, dev = {}) => JSON.stringify({ name: 'x', dependencies: deps, devDependencies: dev });

test('signals: package.json dependencies (react, next, vue, svelte, expo, react-native, electron, express, prisma, ...)', () => {
  assert.deepEqual(ids(project({ 'package.json': pkg({ react: '^19', next: '15' }) })), ['node<package.json', 'react<package.json', 'next<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({ vue: '3' }, { vitest: '1' }) })), ['node<package.json', 'vue<package.json', 'tests<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({ svelte: '5' }) })), ['node<package.json', 'svelte<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({ expo: '51', 'react-native': '0.74', react: '18' }) })), ['node<package.json', 'react<package.json', 'expo<package.json', 'react-native<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({}, { electron: '44' }) })), ['node<package.json', 'electron<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({ express: '5', '@prisma/client': '6' }, { typescript: '5' }) })), ['node<package.json', 'express<package.json', 'prisma<package.json', 'typescript<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({ '@angular/core': '18', tailwindcss: '4', '@anthropic-ai/sdk': '1' }) })), ['node<package.json', 'angular<package.json', 'tailwind<package.json', 'llm<package.json']);
  assert.deepEqual(ids(project({ 'package.json': pkg({}, { vite: '6' }) })), ['node<package.json', 'vite<package.json']);
  // Broken or huge package.json: no signal, no crash
  assert.deepEqual(ids(project({ 'package.json': '{broken' })), []);
  assert.deepEqual(ids(project({ 'package.json': JSON.stringify({ dependencies: { react: '1' }, pad: 'x'.repeat(300 * 1024) }) })), [], 'over 256 KB is not read');
  assert.ok(NPM_SIGNALS.every((s) => /^[a-z-]+$/.test(s.id)));
});

test('signals: Python, Go, Rust (Tauri), .NET, Unity, Unreal, Godot, Flutter, Dockerfile, GitHub workflows', () => {
  assert.deepEqual(ids(project({ 'pyproject.toml': '[project]\ndependencies = [\n  "fastapi>=0.1",\n  "pandas",\n]\n' })), ['python<pyproject.toml', 'fastapi<pyproject.toml', 'pandas<pyproject.toml']);
  assert.deepEqual(ids(project({ 'requirements.txt': '# ml\ntorch==2.3\nDjango>=5\npytest\n' })), ['python<requirements.txt', 'django<requirements.txt', 'ml<requirements.txt', 'pytest<requirements.txt']);
  assert.deepEqual(ids(project({ 'go.mod': 'module x\n' })), ['go<go.mod']);
  assert.deepEqual(ids(project({ 'Cargo.toml': '[package]\nname = "x"\n' })), ['rust<Cargo.toml']);
  assert.deepEqual(ids(project({ 'Cargo.toml': '[dependencies]\ntauri = "2"\n' })), ['rust<Cargo.toml', 'tauri<Cargo.toml']);
  assert.deepEqual(ids(project({ 'App.csproj': '<Project/>' })), ['dotnet<.csproj']);
  assert.deepEqual(ids(project({ 'App.sln': '' })), ['dotnet<.sln']);
  assert.deepEqual(ids(project({}, ['Assets', 'ProjectSettings'])), ['unity<Assets/, ProjectSettings/']);
  assert.deepEqual(ids(project({}, ['Assets'])), [], 'Assets alone is not Unity');
  assert.deepEqual(ids(project({ 'Game.uproject': '{}' })), ['unreal<.uproject']);
  assert.deepEqual(ids(project({ 'project.godot': '' })), ['godot<project.godot']);
  assert.deepEqual(ids(project({ 'pubspec.yaml': 'name: x\n' })), ['flutter<pubspec.yaml']);
  assert.deepEqual(ids(project({ Dockerfile: 'FROM node\n' })), ['docker<Dockerfile']);
  assert.deepEqual(ids(project({}, ['.github/workflows'])), ['ci<.github/workflows']);
  assert.deepEqual(ids(project({})), []);
  assert.deepEqual(projectSignals(path.join(ROOT, 'missing')), []);
});

test('signals: the Unity package manifest adds multiplayer, rendering and localization packages; template packages say nothing; a linked Packages folder is not read', () => {
  const manifest = (deps) => ({ 'Packages/manifest.json': JSON.stringify({ dependencies: deps }) });
  const unity = (files) => project(files, ['Assets', 'ProjectSettings']);
  assert.deepEqual(ids(unity(manifest({ 'com.firstgeargames.fishnet': 'git', 'com.unity.render-pipelines.universal': '17', 'com.unity.localization': '1' }))), ['unity<Assets/, ProjectSettings/', 'unity-multiplayer<Packages/manifest.json', 'unity-rendering<Packages/manifest.json', 'unity-localization<Packages/manifest.json']);
  for (const dep of ['com.unity.netcode.gameobjects', 'com.unity.multiplayer.center', 'com.unity.transport', 'com.unity.services.lobby', 'com.mirror-networking.mirror', 'com.exitgames.photon']) assert.deepEqual(ids(unity(manifest({ [dep]: '1' }))).slice(1), ['unity-multiplayer<Packages/manifest.json'], dep);
  assert.deepEqual(ids(unity(manifest({ 'com.unity.test-framework': '1', 'com.unity.ugui': '2', 'com.unity.inputsystem': '1' }))), ['unity<Assets/, ProjectSettings/'], 'every template ships these');
  assert.deepEqual(ids(unity({ 'Packages/manifest.json': '{broken' })), ['unity<Assets/, ProjectSettings/']);
  // Without Assets/ProjectSettings the manifest is not read; a Packages folder that is a junction is not followed
  assert.deepEqual(ids(project(manifest({ 'com.unity.netcode.gameobjects': '1' }))), []);
  const real = project(manifest({ 'com.unity.netcode.gameobjects': '1' }));
  const linked = unity({});
  fs.symlinkSync(path.join(real, 'Packages'), path.join(linked, 'Packages'), 'junction');
  assert.deepEqual(ids(linked), ['unity<Assets/, ProjectSettings/']);
});

const LIB = [
  { kind: 'skill', name: 'react-patterns', category: 'web', description: 'Hooks and components' },
  { kind: 'agent', name: 'frontend-dev', category: 'web', description: 'Builds React pages' },
  { kind: 'skill', name: 'unity-shaders', category: 'game', description: 'Shader graph' },
  { kind: 'skill', name: 'docker-deploy', category: 'devops', description: 'Container images' },
  { kind: 'skill', name: 'a-web-skill', category: 'web', description: 'Plain' },
  { kind: 'skill', name: 'writing', category: 'docs', description: 'Docs' },
];

test('ranking: category match 2, name keyword 3, description keyword 1, registry package 4; sorted by score, kind, name; reason of the strongest signal', () => {
  const dir = project({ 'package.json': pkg({ react: '19' }), Dockerfile: 'FROM x' });
  const signals = projectSignals(dir);
  const r = rankItems(LIB, signals);
  assert.deepEqual(r.map((i) => `${i.kind}:${i.name}:${i.score}`), ['skill:docker-deploy:5', 'skill:react-patterns:5', 'agent:frontend-dev:3', 'skill:a-web-skill:2'], 'equal scores: skills before agents, then by name');
  assert.deepEqual(r[0].reason, { from: 'Dockerfile', signal: 'docker', match: 'category' });
  assert.deepEqual(r[1].reason, { from: 'package.json', signal: 'react', match: 'category' });
  assert.deepEqual(r[2].reason, { from: 'package.json', signal: 'react', match: 'category' });
  assert.deepEqual(rankItems(LIB, signals), r, 'deterministic');
  assert.deepEqual(rankItems([...LIB].reverse(), signals), r, 'independent of the library order');
  // Registry packages outweigh a file signal
  const withReg = rankItems(LIB, [...registrySignals(['docs', 'external-pkg'], new Set(['web', 'docs', 'game', 'devops'])), ...signals]);
  assert.deepEqual(withReg.slice(0, 3).map((i) => `${i.name}:${i.score}`), ['docker-deploy:5', 'react-patterns:5', 'writing:4']);
  assert.deepEqual(withReg.find((i) => i.name === 'writing').reason, { from: 'registry', signal: 'docs', match: 'category' });
  assert.equal(withReg.find((i) => i.name === 'writing').score, 4);
  assert.deepEqual(registrySignals(['docs', 'docs', 7, 'nope'], new Set(['docs'])).map((s) => s.id), ['docs'], 'only library categories, once');
  assert.deepEqual(rankItems(LIB, []), [], 'no signal: no suggestion');
  assert.ok(rankItems(Array.from({ length: 80 }, (_, i) => ({ kind: 'skill', name: `w${i}`, category: 'web', description: '' })), signals).length === MAX_SUGGESTIONS);
});

// A hub with a small library, an install record and a catalog double
function hubWorld() {
  const hub = path.join(ROOT, `hub${++n}`);
  initHub(hub);
  const lib = (cat, kind, name, desc) => (kind === 'skill' ? write(path.join(hub, 'library', cat, 'skills', name, 'SKILL.md'), fm(name, desc)) : write(path.join(hub, 'library', cat, 'agents', `${name}.md`), fm(name, desc)));
  lib('web', 'skill', 'react-patterns', 'Hooks');
  lib('web', 'agent', 'frontend-dev', 'Builds React pages');
  lib('game', 'skill', 'unity-shaders', 'Shaders');
  lib('docs', 'skill', 'writing', 'Docs');
  const web = project({ 'package.json': pkg({ react: '19' }) });
  const unity = project({}, ['Assets', 'ProjectSettings']);
  const projects = [
    { id: 'web', name: 'Web', kind: 'registered', path: web, packages: ['docs', 'ccgs'] },
    { id: 'unity', name: 'Unity', kind: 'adhoc', path: unity, packages: ['docs'] },
    { id: 'broad', name: 'Home', kind: 'adhoc', path: ROOT, broad: true, packages: [] },
    { id: 'gone', name: 'Gone', kind: 'registered', path: path.join(ROOT, 'gone'), packages: ['web'] },
  ];
  const roster = new Map([['skill:writing', { kind: 'skill', name: 'writing', installedIn: ['web'] }], ['agent:frontend-dev', { kind: 'agent', name: 'frontend-dev', installedIn: ['web'] }]]);
  write(path.join(hub, 'registry', 'installs.json'), JSON.stringify({ version: 1, installs: [{ project: 'web', target: 'claude', kind: 'agent', name: 'frontend-dev', path: path.join(web, '.claude', 'agents', 'frontend-dev.md'), hash: 'h', source: 'library/web/agents/frontend-dev.md', installedAt: '2026-09-28T00:00:00.000Z' }] }));
  return { hub, catalog: { hubDir: hub, roster, getProject: (id) => projects.find((p) => p.id === id) || null } };
}

test('suggestions: installed items are marked (by SiberSentez or project-owned), never dropped; registry packages only for a registered project', () => {
  const w = hubWorld();
  const r = projectSuggestions({ catalog: w.catalog, projectId: 'web' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.signals, [{ id: 'docs', from: 'registry' }, { id: 'node', from: 'package.json' }, { id: 'react', from: 'package.json' }]);
  assert.deepEqual(r.body.items.map((i) => `${i.kind}:${i.name}:${i.installed}:${i.installedBy}:${i.targets.join('+')}`), ['skill:react-patterns:false:null:', 'skill:writing:true:project:', 'agent:frontend-dev:true:sibersentez:claude']);
  assert.deepEqual(Object.keys(r.body.items[0]).sort(), ['category', 'description', 'installed', 'installedBy', 'kind', 'name', 'reason', 'score', 'targets']);
  // An unregistered project: its packages do not count, its folder does
  const u = projectSuggestions({ catalog: w.catalog, projectId: 'unity' });
  assert.deepEqual(u.body.signals, [{ id: 'unity', from: 'Assets/, ProjectSettings/' }]);
  assert.deepEqual(u.body.items.map((i) => i.name), ['unity-shaders']);
  // A broad or missing folder is not read; registry packages still count
  assert.deepEqual(projectSuggestions({ catalog: w.catalog, projectId: 'broad' }).body.items, []);
  assert.deepEqual(projectSuggestions({ catalog: w.catalog, projectId: 'gone' }).body.items.map((i) => i.name), ['react-patterns', 'frontend-dev']);
  assert.equal(projectSuggestions({ catalog: w.catalog, projectId: 'nope' }).status, 404);
  // No hub, legacy hub
  assert.equal(projectSuggestions({ catalog: { ...w.catalog, hubDir: null }, projectId: 'web', hubDir: null }).body.problem, 'no-hub');
  const legacy = path.join(ROOT, 'legacy-hub');
  write(path.join(legacy, 'registry', 'projeler.json'), JSON.stringify({ projeler: [] }));
  assert.equal(projectSuggestions({ catalog: w.catalog, projectId: 'web', hubDir: legacy }).body.problem, 'legacy-hub');
});

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
          /* not JSON (421 answers in plain text) */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/projects/<id>/suggestions: read-only, no action mode needed; the usual access rules; unknown or malformed ids', async () => {
  const w = hubWorld();
  const before = fs.readdirSync(path.join(w.hub, 'registry')).sort();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Actions off (the default): the endpoint still answers
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions: { mode: 'off' } }));
  try {
    const r = await get(port, '/api/projects/web/suggestions', { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.project, 'web');
    assert.equal(r.json.items.length, 3);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal((await get(port, '/api/projects/nope/suggestions', { 'Sec-Fetch-Site': 'same-origin' })).status, 404);
    assert.equal((await get(port, '/api/projects/web/suggestions', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).status, 403);
    assert.equal((await get(port, '/api/projects/web/suggestions', { Host: `evil.example:${port}` })).status, 421);
    for (const bad of ['/api/projects/-web/suggestions', '/api/projects/a%2F..%2Fb/suggestions', '/api/projects/web/suggestions/x', '/api/projects//suggestions']) assert.equal((await get(port, bad, { 'Sec-Fetch-Site': 'same-origin' })).status, 404, bad);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(fs.readdirSync(path.join(w.hub, 'registry')).sort(), before, 'nothing written');
});

// ---------------- review round 1 (docs/skills-flow.md §3.9) ----------------
const junction = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
};

test('suggestions: a library item whose name fails the name rule is never offered (an install request with it would be refused as a whole)', () => {
  const w = hubWorld();
  write(path.join(w.hub, 'library', 'web', 'skills', 'bad-folder', 'SKILL.md'), fm('React Helper', 'react'));
  write(path.join(w.hub, 'library', 'web', 'agents', 'dotted.md'), fm('react-agent.', 'react'));
  write(path.join(w.hub, 'library', 'web', 'agents', 'device.md'), fm('con', 'react'));
  const r = projectSuggestions({ catalog: w.catalog, projectId: 'web' });
  assert.deepEqual(r.body.items.map((i) => i.name), ['react-patterns', 'writing', 'frontend-dev']);
  assert.deepEqual(rankItems([{ kind: 'skill', name: 'bad name', category: 'web', description: 'react' }, { kind: 'skill', name: 'ok', category: 'web', description: '' }], projectSignals(project({ 'package.json': pkg({ react: '19' }) }))).map((i) => i.name), ['ok']);
});

test('signals: a project root that is a junction is read one hop (names and small manifests of its target); a link to a link, a broad or missing target is not', () => {
  const target = project({ 'package.json': pkg({ react: '19' }), Dockerfile: 'FROM x' });
  const at = path.join(ROOT, 'junction-root');
  junction(target, at);
  assert.deepEqual(ids(at), ['node<package.json', 'react<package.json', 'docker<Dockerfile']);
  // Inside the target nothing is followed: a linked Assets folder does not make a Unity project
  const inner = project({ 'Cargo.toml': '[package]\n' });
  const t2 = project({});
  junction(inner, path.join(t2, 'Assets'));
  fs.mkdirSync(path.join(t2, 'ProjectSettings'));
  const at2 = path.join(ROOT, 'junction-root-2');
  junction(t2, at2);
  assert.deepEqual(ids(at2), [], 'a linked Assets folder is not a Unity project');
  // A link to a link: not followed
  const at3 = path.join(ROOT, 'junction-to-junction');
  junction(at, at3);
  assert.deepEqual(ids(at3), []);
  // A broad target: not read
  const at4 = path.join(ROOT, 'junction-broad');
  junction(target, at4);
  assert.deepEqual(projectSignals(at4, { broad: (d) => path.resolve(d).toLowerCase() === path.resolve(target).toLowerCase() }), []);
  // A missing target: nothing
  const gone = project({ 'package.json': pkg({ react: '19' }) });
  const at5 = path.join(ROOT, 'junction-gone');
  junction(gone, at5);
  fs.rmSync(gone, { recursive: true });
  assert.deepEqual(ids(at5), []);
  // Through the endpoint: a registered project whose folder is a junction gets its signals
  const w = hubWorld();
  const catalog = { ...w.catalog, getProject: (id) => (id === 'linked' ? { id, name: 'Linked', kind: 'adhoc', path: at, packages: [] } : null) };
  const r = projectSuggestions({ catalog, projectId: 'linked' });
  assert.deepEqual(r.body.signals, [{ id: 'node', from: 'package.json' }, { id: 'react', from: 'package.json' }, { id: 'docker', from: 'Dockerfile' }]);
  assert.deepEqual(r.body.items.map((i) => i.name), ['react-patterns', 'frontend-dev']);
  // A project path with a ':' after the drive letter is never read
  const ads = { ...w.catalog, getProject: (id) => ({ id, name: 'Ads', kind: 'adhoc', path: target + '::$INDEX_ALLOCATION', packages: [] }) };
  assert.deepEqual(projectSuggestions({ catalog: ads, projectId: 'ads' }).body.signals, []);
});
