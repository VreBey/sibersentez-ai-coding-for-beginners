// Discovery tests (contract §4, §5, §9): the app lists the skills and agents on the machine with the right sources.
// At the end: the roster's library count and folder filter (public/js/rosterModel.js), which read these items.
// Run: node --test test/catalog.test.mjs
// A fake home folder is built under the system temp folder (~/.claude, plugins, projects, hub); the real home
// folder, %APPDATA% and the tool folders are not read: every catalog gets a fake home, Claude folder and environment
// (FAKE_ENV: no APPDATA, CODEX_HOME or COPILOT_HOME, so every other tool's root lies in the fake home). The check of
// this machine's installed_plugins.json SHAPE runs only on request (SIBERSENTEZ_REAL_MACHINE_TESTS=1, read-only).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Catalog, SOURCE_ORDER, STEP_MS, resolveSlug, readHeadCwd, personalDir } from '../server/catalog.mjs';
import { ProjectMemory } from '../server/memory.mjs';
import { initHub } from '../server/hub.mjs';
import { slugify, normPath } from '../server/util.mjs';
import { Ingest } from '../server/ingest.mjs';
import { snapshot, rosterView, hubView } from '../server/views.mjs';
import { baseName, copyKey, libraryCounts, foldersOf, folderGroupOf, matchesFolder, matchesFilter, folderIndex, folderCounts, folderGroups, parseFolder, sourceFolder, FOLDER_GROUPS } from '../public/js/rosterModel.js';
import { WIN_ONLY } from './lib/winonly.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-catalog-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const FAKE_ENV = Object.freeze({});

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const skill = (dir, name) => write(path.join(dir, name, 'SKILL.md'), fm(name));
const agent = (file, name) => write(file, fm(name));

// ---------------- fake world ----------------
const HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(HOME, '.claude');
const HUB = path.join(ROOT, 'hub');
const P_REG = path.join(HOME, 'work', 'registered');
const P_LOG = path.join(HOME, 'work', 'from-logs');
const P_EMPTY = path.join(HOME, 'work', 'empty');
const PLUG_ON = path.join(CLAUDE, 'plugins', 'cache', 'market', 'sample-plugin', '1.2.3');
const PLUG_OFF = path.join(CLAUDE, 'plugins', 'cache', 'market', 'disabled', '1.0.0');
const SYNCED_BUCKET = path.join(CLAUDE, 'plugins', 'synced', 'account-bucket');
const SYNCED_PLUG = path.join(SYNCED_BUCKET, 'cloud-plugin');

// Personal skills (synced excluded) and nested agents
skill(path.join(CLAUDE, 'skills'), 'personal-skill');
skill(path.join(CLAUDE, 'skills'), 'shared'); // also in the library
fs.mkdirSync(path.join(CLAUDE, 'skills', 'empty-folder'), { recursive: true }); // no SKILL.md: not a skill
agent(path.join(CLAUDE, 'agents', 'personal-agent.md'), 'personal-agent');
agent(path.join(CLAUDE, 'agents', 'sub', 'inner-agent.md'), 'inner-agent');
agent(path.join(CLAUDE, 'agents', 'sub', 'deep', 'deepest.md'), 'deepest');
agent(path.join(CLAUDE, 'agents', 'sub', 'deep', 'too', 'too-deep.md'), 'too-deep'); // third sublevel: not scanned
write(path.join(CLAUDE, 'agents', 'README.md'), '# agents\n');
agent(path.join(CLAUDE, 'agents', '.git', 'hidden-agent.md'), 'hidden-agent');
// Skills synced from claude.ai: the flat layout of the contract and the account-bucket layout seen on real machines
skill(path.join(CLAUDE, 'skills', 'synced'), 'cloud-flat');
skill(path.join(CLAUDE, 'skills', 'synced', 'account-bucket'), 'cloud-skill');
write(path.join(CLAUDE, 'skills', 'synced', 'account-bucket', 'manifest.json'), '{"skills": []}');

// Plugins: the installed_plugins.json shape of real machines (version 2, id -> array of install records)
const entry = (installPath, version) => ({ scope: 'user', installPath, version, installedAt: '2026-08-11T09:11:43.088Z', lastUpdated: '2026-08-11T09:11:43.088Z', gitCommitSha: 'aa8d778811a557a2c28ccadda4cf3d0bd028a4cc' });
write(
  path.join(CLAUDE, 'plugins', 'installed_plugins.json'),
  JSON.stringify({
    version: 2,
    plugins: {
      'sample-plugin@market': [entry(PLUG_ON, '1.2.3')],
      'disabled@market': [entry(PLUG_OFF, '1.0.0')],
      'no-path@market': [{ scope: 'user', version: '9.9.9' }], // no installPath: skipped silently
      'broken@market': 'text', // record is not an object: skipped
      'empty-array@market': [],
    },
  }),
);
write(path.join(CLAUDE, 'settings.json'), JSON.stringify({ enabledPlugins: { 'sample-plugin@market': true, 'disabled@market': false } }));
skill(path.join(PLUG_ON, 'skills'), 'p-skill');
agent(path.join(PLUG_ON, 'agents', 'p-agent.md'), 'p-agent');
agent(path.join(PLUG_ON, 'agents', 'group', 'p-inner.md'), 'p-inner');
write(path.join(PLUG_ON, '.in_use', 'x.md'), 'hidden');
skill(path.join(PLUG_OFF, 'skills'), 'd-skill');
// Plugins synced from claude.ai: the folder name may differ from the plugin name (taken from .claude-plugin/plugin.json)
write(path.join(SYNCED_PLUG, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cloud', description: 'Cloud plugin' }));
write(path.join(SYNCED_BUCKET, 'cloud-plugin.meta.json'), JSON.stringify({ marketplace_name: 'knowledge', installation_preference: 'available' }));
skill(path.join(SYNCED_PLUG, 'skills'), 'c-skill');
agent(path.join(SYNCED_PLUG, 'agents', 'c-agent.md'), 'c-agent');
const SYNCED_OFF = path.join(SYNCED_BUCKET, 'cloud-off');
write(path.join(SYNCED_OFF, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cloud-off' }));
write(path.join(SYNCED_BUCKET, 'cloud-off.meta.json'), JSON.stringify({ installation_preference: 'disabled' }));
skill(path.join(SYNCED_OFF, 'skills'), 'off-skill');
fs.mkdirSync(path.join(SYNCED_BUCKET, 'not-a-plugin', 'skills'), { recursive: true });

// Projects: registered (in the hub), found in the logs, without a .claude folder
skill(path.join(P_REG, '.claude', 'skills'), 'registered-skill');
agent(path.join(P_REG, '.claude', 'agents', 'registered-agent.md'), 'registered-agent');
skill(path.join(P_LOG, '.claude', 'skills'), 'log-skill');
skill(path.join(P_LOG, '.claude', 'skills'), 'lib-skill'); // installed from the library into the project
agent(path.join(P_LOG, '.claude', 'agents', 'sub', 'log-agent.md'), 'log-agent');
fs.mkdirSync(P_EMPTY, { recursive: true });

// Hub: English registry and library catalog (contract §9)
write(path.join(HUB, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'registered', name: 'Registered', path: P_REG, description: '', packages: [] }] }));
write(
  path.join(HUB, 'library', 'catalog.json'),
  JSON.stringify({
    updated: null,
    count: 3,
    items: [
      { name: 'lib-skill', kind: 'skill', category: 'web', description: 'library skill' },
      { name: 'lib-agent', kind: 'agent', category: 'design', description: 'library agent' },
      { name: 'shared', kind: 'skill', category: 'general', description: 'both personal and library' },
      { kind: 'skill' }, // no name: not counted
    ],
  }),
);

// Catalog plus projects found in the logs (through adhocFor, as Ingest does; resolve could mistake temp folder
// paths for scratchpads, so the real folder path is given directly)
function build({ hubDir = HUB } = {}) {
  const c = new Catalog({ env: FAKE_ENV, hubDir, claudeDir: CLAUDE, homeDir: HOME });
  c.loadProjects();
  const log = c.adhocFor(P_LOG);
  const home = c.adhocFor(HOME);
  const empty = c.adhocFor(P_EMPTY);
  c.load();
  return { c, log, home, empty };
}
const item = (c, kind, name) => c.roster.get(`${kind}:${name}`.toLowerCase());

// ---------------- tests ----------------
test('personal: ~/.claude/skills (synced excluded) and nested ~/.claude/agents; no SKILL.md-less folder, README, hidden folder or third sublevel', () => {
  const { c } = build();
  const s = item(c, 'skill', 'personal-skill');
  assert.equal(s.source, 'personal');
  assert.deepEqual(s.sources, ['personal']);
  assert.equal(s.global, true);
  assert.deepEqual(s.installedIn, []);
  for (const a of ['personal-agent', 'inner-agent', 'deepest']) {
    assert.equal(item(c, 'agent', a)?.source, 'personal', a);
    assert.deepEqual(item(c, 'agent', a).sources, ['personal'], a);
  }
  assert.equal(item(c, 'agent', 'too-deep'), undefined, 'at most 2 sublevels per folder');
  assert.equal(item(c, 'agent', 'hidden-agent'), undefined, 'hidden folders such as .git are skipped');
  assert.equal(item(c, 'agent', 'readme'), undefined);
  assert.equal(item(c, 'skill', 'empty-folder'), undefined, 'no SKILL.md: not a skill');
  assert.equal(item(c, 'skill', 'synced'), undefined, 'synced is not a personal skill');
});

test('claudeai: synced/<name> and synced/<account>/<name> layouts; synced plugin items are named <plugin>:<item>', () => {
  const { c } = build();
  for (const n of ['cloud-flat', 'cloud-skill']) {
    const s = item(c, 'skill', n);
    assert.equal(s?.source, 'claudeai', n);
    assert.deepEqual(s.sources, ['claudeai']);
    assert.equal(s.global, true);
  }
  assert.equal(item(c, 'skill', 'account-bucket'), undefined, 'the account bucket is not a skill');
  const p = item(c, 'plugin', 'cloud');
  assert.equal(p?.source, 'claudeai');
  assert.equal(p.pluginId, 'cloud@knowledge');
  assert.equal(p.enabled, true, 'claude.ai preference "available": enabled');
  assert.equal(item(c, 'skill', 'cloud:c-skill')?.source, 'claudeai');
  assert.equal(item(c, 'skill', 'cloud:c-skill').plugin, 'cloud@knowledge');
  assert.equal(item(c, 'skill', 'cloud:c-skill').enabled, true);
  assert.equal(item(c, 'agent', 'cloud:c-agent')?.source, 'claudeai');
  assert.equal(item(c, 'plugin', 'cloud-off').enabled, false, 'explicitly disabled preference');
  assert.equal(item(c, 'skill', 'cloud-off:off-skill').enabled, false);
  assert.equal(item(c, 'skill', 'cloud-off:off-skill').global, false);
  assert.equal(item(c, 'plugin', 'not-a-plugin'), undefined, 'a folder without plugin.json is not a plugin');
});

test('plugin: skills/*/SKILL.md and agents/**/*.md from the install folder in installed_plugins.json; named <plugin>:<item>, with plugin and enabled', () => {
  const { c } = build();
  const on = item(c, 'plugin', 'sample-plugin');
  assert.equal(on.kind, 'plugin', 'the plugin itself is an item too');
  assert.equal(on.source, 'plugin');
  assert.equal(on.pluginId, 'sample-plugin@market');
  assert.equal(on.enabled, true);
  assert.match(on.description, /1\.2\.3/);
  const s = item(c, 'skill', 'sample-plugin:p-skill');
  assert.equal(s.name, 'sample-plugin:p-skill');
  assert.equal(s.source, 'plugin');
  assert.deepEqual(s.sources, ['plugin']);
  assert.equal(s.plugin, 'sample-plugin@market');
  assert.equal(s.enabled, true);
  assert.equal(s.global, true);
  assert.equal(item(c, 'agent', 'sample-plugin:p-agent')?.source, 'plugin');
  assert.equal(item(c, 'agent', 'sample-plugin:p-inner')?.source, 'plugin', 'nested agents/');
  assert.equal(item(c, 'skill', 'p-skill'), undefined, 'plugin items are never listed without the namespace');
  const off = item(c, 'skill', 'disabled:d-skill');
  assert.equal(off.enabled, false);
  assert.equal(off.global, false);
  assert.equal(item(c, 'plugin', 'disabled').enabled, false);
  for (const n of ['no-path', 'broken', 'empty-array']) assert.equal(item(c, 'plugin', n), undefined, `${n}: a plugin with missing fields is skipped silently`);
});

test('project: .claude of registered projects and of projects found in logs; installedIn holds project ids; the home project is not scanned', () => {
  const { c, log, home } = build();
  const reg = item(c, 'skill', 'registered-skill');
  assert.equal(reg.source, 'project');
  assert.deepEqual(reg.installedIn, ['registered']);
  assert.deepEqual(item(c, 'agent', 'registered-agent').installedIn, ['registered']);
  assert.deepEqual(c.getProject('registered').installed, { skills: 1, agents: 1 });
  // A project with no registry entry (found in logs): these used to be missing entirely
  assert.equal(log.kind, 'adhoc');
  const l = item(c, 'skill', 'log-skill');
  assert.equal(l?.source, 'project');
  assert.deepEqual(l.installedIn, [log.id]);
  assert.deepEqual(item(c, 'agent', 'log-agent').installedIn, [log.id]);
  assert.deepEqual(log.installed, { skills: 2, agents: 1 });
  // Home project: its .claude is the personal folder and must not be counted again as a project
  assert.equal(home.broad, true);
  assert.deepEqual(home.installed, { skills: 0, agents: 0 });
  assert.deepEqual(item(c, 'skill', 'personal-skill').installedIn, []);
  assert.ok(![...c.roster.values()].some((i) => i.installedIn.includes(home.id)));
});

test('library: the hub catalog, category = library category; a name found in several places lists every source in sources', () => {
  const { c, log } = build();
  const lib = item(c, 'skill', 'lib-skill');
  assert.equal(lib.source, 'library', 'a library item installed in a project stays a library item');
  assert.deepEqual(lib.sources, ['library', 'project']);
  assert.equal(lib.category, 'web');
  assert.deepEqual(lib.installedIn, [log.id]);
  const a = item(c, 'agent', 'lib-agent');
  assert.equal(a.source, 'library');
  assert.equal(a.category, 'design');
  assert.equal(a.global, false);
  const both = item(c, 'skill', 'shared');
  assert.equal(both.source, 'personal', 'the source active in every project is the primary one');
  assert.deepEqual(both.sources, ['personal', 'library']);
  assert.equal(both.category, 'general', 'the library category is kept');
  assert.equal(both.global, true);
  // Every item has sources, in a fixed order, starting with its primary source
  for (const it of c.roster.values()) {
    assert.ok(Array.isArray(it.sources) && it.sources.length >= 1, it.name);
    assert.equal(it.sources[0], it.source, it.name);
    const order = it.sources.map((s) => SOURCE_ORDER.indexOf(s));
    assert.ok(order.every((i) => i >= 0), `${it.name}: only English source names`);
    assert.deepEqual(order, [...order].sort((x, y) => x - y), it.name);
  }
  assert.deepEqual([...SOURCE_ORDER].sort(), ['builtin', 'claudeai', 'kit', 'library', 'personal', 'plugin', 'project']);
  assert.equal(item(c, 'agent', 'general-purpose')?.source, 'builtin');
  assert.equal(c.kitDir, null, 'a catalog with an environment of its own reads no kit by itself');
  assert.equal(c.kit, null);
  assert.ok(![...c.roster.values()].some((it) => it.sources.includes('kit')));
});

// ---------------- the SiberSentez kit (server/kit.mjs) as a roster source ----------------

// A small kit in the library layout: a skill and an agent, one of them also in the user's library and personal folder
const KIT_DIR_T = path.join(ROOT, 'kit');
write(path.join(KIT_DIR_T, 'catalog.json'), JSON.stringify({ name: 'sibersentez-kit', version: '0.2.0', items: [] }));
const kitFm = (name, description, extra = '') => `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  version: "0.2.1"\n  sibersentez-tags: "planning"\n  sibersentez-stage: "start"\n  sibersentez-keywords-tr: "fikir*, plan*"\n${extra}---\n\n# ${name}\n`;
write(path.join(KIT_DIR_T, 'planning', 'skills', 'kit-plan', 'SKILL.md'), kitFm('kit-plan', 'Plans a project. Use when starting.'));
write(path.join(KIT_DIR_T, 'planning', 'skills', 'kit-plan', 'LICENSE.md'), 'notice');
write(path.join(KIT_DIR_T, 'quality', 'agents', 'kit-review.md'), kitFm('kit-review', 'Reviews changes. Use when done.'));
write(path.join(KIT_DIR_T, 'quality', 'skills', 'shared', 'SKILL.md'), kitFm('shared', 'The kit copy of shared.'));
const P_KIT = path.join(HOME, 'work', 'kit-user');
skill(path.join(P_KIT, '.claude', 'skills'), 'kit-plan'); // installed from the kit into a project found in the logs

test('kit: the SiberSentez kit is a roster source of its own ("kit"): after the library, never active until installed, with its kit folder and version; the user library keeps its name, category and description', () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  c.kitDir = KIT_DIR_T;
  c.loadProjects();
  const log = c.adhocFor(P_KIT);
  c.load();
  const plan = item(c, 'skill', 'kit-plan');
  assert.equal(plan.source, 'kit', 'installed into a project, a kit item stays a kit item (as a library item does)');
  assert.deepEqual(plan.sources, ['kit', 'project']);
  assert.deepEqual(plan.installedIn, [log.id]);
  assert.equal(plan.category, 'planning');
  assert.equal(plan.kitCategory, 'planning');
  assert.equal(plan.kitVersion, '0.2.1');
  assert.equal(plan.stage, 'start');
  assert.equal(plan.global, false);
  assert.deepEqual(plan.tools, ['claude-code'], 'the project copy was reported by the Claude Code adapter; the kit itself is no tool');
  const review = item(c, 'agent', 'kit-review');
  assert.deepEqual(review.sources, ['kit']);
  assert.deepEqual(review.installedIn, []);
  assert.equal(review.kitCategory, 'quality');
  // A name in the personal folder, the library and the kit: personal first, the library category and description
  const shared = item(c, 'skill', 'shared');
  assert.deepEqual(shared.sources, ['personal', 'library', 'kit']);
  assert.equal(shared.category, 'general', 'the library category, not the kit one');
  assert.equal(shared.kitCategory, 'quality', 'the kit folder it also sits in');
  assert.equal(shared.description, 'both personal and library');
  // The library count stays the user's own; the kit has its own summary
  assert.deepEqual(c.hub, { path: HUB, projects: 1, library: 3 });
  assert.deepEqual(c.kit, { version: '0.2.0', skill: 2, agent: 1, total: 3 });
  // The view sends the kit fields as they are
  const snap = snapshot(new Ingest(c), c);
  const r = snap.roster.find((x) => x.id === 'agent:kit-review');
  assert.deepEqual([r.source, r.kitCategory, r.stage], ['kit', 'quality', 'start']);
  // No kit folder: nothing from the kit, nothing breaks
  const none = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  none.kitDir = path.join(ROOT, 'no-such-kit');
  none.load();
  assert.equal(none.kit, null);
  assert.equal(item(none, 'agent', 'kit-review'), undefined);
});

test('kit: the app catalog reads the settings kit (KIT_DIR); only the process environment turns it on by default', async () => {
  const { KIT_DIR } = await import('../server/config.mjs');
  const c = new Catalog({ hubDir: null, claudeDir: CLAUDE, homeDir: HOME });
  assert.equal(c.kitDir, KIT_DIR);
  assert.equal(new Catalog({ env: {}, hubDir: null }).kitDir, null);
});

test('personal items carry their home-relative folder (personalDirs) for the folder filter; never a full path, no field on other items', () => {
  const { c } = build();
  assert.deepEqual(item(c, 'skill', 'personal-skill').personalDirs, ['~/.claude/skills']);
  assert.deepEqual(item(c, 'agent', 'personal-agent').personalDirs, ['~/.claude/agents']);
  assert.deepEqual(item(c, 'agent', 'inner-agent').personalDirs, ['~/.claude/agents'], 'a nested agent belongs to its agents folder');
  assert.deepEqual(item(c, 'agent', 'deepest').personalDirs, ['~/.claude/agents']);
  assert.deepEqual(item(c, 'skill', 'shared').personalDirs, ['~/.claude/skills'], 'a library item that is also personal keeps the personal folder');
  for (const name of ['lib-skill', 'cloud-skill', 'log-skill', 'sample-plugin:p-skill']) assert.equal(item(c, 'skill', name)?.personalDirs, undefined, name);
  const snap = snapshot(new Ingest(c), c);
  const dirs = snap.roster.flatMap((r) => r.personalDirs || []);
  assert.ok(dirs.length >= 5);
  assert.ok(dirs.every((d) => d.startsWith('~/') && !d.includes('\\') && !normPath(d).includes(normPath(HOME))), 'only home-relative folders reach the client');
});

test('personalDir: skills and agents folders relative to the home folder; nested agents, agent.md folders; outside home only the last two parts', () => {
  const home = path.join(ROOT, 'pd-home');
  assert.equal(personalDir(path.join(home, '.agents', 'skills', 'x', 'SKILL.md'), 'skill', home), '~/.agents/skills');
  assert.equal(personalDir(path.join(home, '.gemini', 'config', 'skills', 'x', 'SKILL.md'), 'skill', home), '~/.gemini/config/skills');
  assert.equal(personalDir(path.join(home, '.codex', 'agents', 'a.toml'), 'agent', home), '~/.codex/agents');
  assert.equal(personalDir(path.join(home, '.gemini', 'config', 'agents', 'helper', 'agent.md'), 'agent', home), '~/.gemini/config/agents');
  assert.equal(personalDir(path.join(home, '.claude', 'agents', 'a', 'b', 'c.md'), 'agent', home), '~/.claude/agents');
  assert.equal(personalDir(path.join(home, 'odd', 'place', 'x.md'), 'agent', home), '~/odd/place', 'no agents folder above: the file folder');
  assert.equal(personalDir(path.join(ROOT, 'elsewhere', 'codex-home', 'skills', 'x', 'SKILL.md'), 'skill', home), '…/codex-home/skills');
  assert.equal(personalDir(null, 'skill', home), null);
  assert.equal(personalDir(path.join(home, 'x.md'), 'agent', ''), null);
});

test('no fake hub project; the snapshot carries the hub summary { path, projects, library }', () => {
  const { c } = build();
  const all = c.allProjects();
  assert.ok(!all.some((p) => p.kind === 'hub'), 'the hub is never added as a project');
  assert.ok(!all.some((p) => p.path && path.resolve(p.path) === path.resolve(HUB)));
  assert.deepEqual(c.projects.map((p) => p.id), ['registered']);
  assert.deepEqual(c.hub, { path: HUB, projects: 1, library: 3 });
  const ing = new Ingest(c);
  const snap = snapshot(ing, c);
  assert.deepEqual(snap.hub, { path: HUB, projects: 1, library: 3 });
  assert.ok(snap.projects.every((p) => p.kind !== 'hub'));
  assert.ok(snap.roster.every((r) => Array.isArray(r.sources)));
  // The view does not share the catalog item's arrays (a copy goes to the client)
  const r = snap.roster.find((x) => x.id === 'skill:lib-skill');
  assert.notEqual(r.sources, item(c, 'skill', 'lib-skill').sources);
});

test('works with a null hub: registry and library empty; personal, claudeai, project and plugin items still listed', () => {
  const { c, log } = build({ hubDir: null });
  assert.equal(c.hub, null);
  assert.equal(hubView(c), null);
  assert.deepEqual(c.projects, [], 'empty registry');
  assert.ok(![...c.roster.values()].some((i) => i.sources.includes('library')));
  const lib = item(c, 'skill', 'lib-skill');
  assert.equal(lib.source, 'project', 'without a library the copy in the project is a project item');
  assert.deepEqual(lib.installedIn, [log.id]);
  assert.equal(item(c, 'skill', 'personal-skill').source, 'personal');
  assert.equal(item(c, 'skill', 'cloud-skill').source, 'claudeai');
  assert.equal(item(c, 'skill', 'sample-plugin:p-skill').source, 'plugin');
  assert.equal(item(c, 'skill', 'shared').category, 'personal');
  assert.equal(snapshot(new Ingest(c), c).hub, null);
  // A hub path that does not exist does not crash either: it reads as empty
  const ghost = new Catalog({ env: FAKE_ENV, hubDir: path.join(ROOT, 'missing-hub'), claudeDir: CLAUDE, homeDir: HOME });
  assert.doesNotThrow(() => ghost.load());
  assert.deepEqual(ghost.hub, { path: path.join(ROOT, 'missing-hub'), projects: 0, library: 0 });
});

test('legacy hub (registry/projeler.json, kutuphane/katalog.json) is read through the adapter with the same result', { skip: WIN_ONLY }, () => {
  const old = path.join(ROOT, 'legacy-hub');
  write(path.join(old, 'registry', 'projeler.json'), JSON.stringify({ projeler: [{ id: 'registered', ad: 'Registered', yol: P_REG }, { ad: 'no id' }, null, { id: 'registered' }] }));
  write(path.join(old, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [{ ad: 'lib-skill', tur: 'skill', kategori: 'web', aciklama: 'library skill' }, { ad: 'lib-agent', tur: 'agent', kategori: 'design' }, { ad: 'shared', tur: 'skill', kategori: 'general' }] }));
  const { c: modern } = build();
  const { c: legacy } = build({ hubDir: old });
  assert.deepEqual(legacy.projects.map((p) => p.id), ['registered'], 'rows without an id and duplicates are skipped');
  assert.deepEqual(legacy.hub, { path: old, projects: 1, library: 3 });
  const pick = (c) =>
    [...c.roster.values()]
      .filter((i) => i.sources.includes('library') || i.sources.includes('project'))
      .map((i) => ({ key: `${i.kind}:${i.name}`, source: i.source, sources: i.sources, category: i.category, installedIn: i.installedIn.length }))
      .sort((a, b) => a.key.localeCompare(b.key));
  assert.ok(pick(legacy).length >= 6);
  assert.deepEqual(pick(legacy), pick(modern));
});

test('broken registry, catalog and installed_plugins.json never take the app down', () => {
  const bad = path.join(ROOT, 'bad-hub');
  write(path.join(bad, 'registry', 'projects.json'), '{broken');
  write(path.join(bad, 'library', 'catalog.json'), '[1, 2]');
  const c = new Catalog({ env: FAKE_ENV, hubDir: bad, claudeDir: CLAUDE, homeDir: HOME });
  assert.doesNotThrow(() => c.load());
  assert.deepEqual(c.hub, { path: bad, projects: 0, library: 0 });
  const home2 = path.join(ROOT, 'home2');
  write(path.join(home2, '.claude', 'plugins', 'installed_plugins.json'), '{broken');
  write(path.join(home2, '.claude', 'settings.json'), '[]');
  const c2 = new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: path.join(home2, '.claude'), homeDir: home2 });
  assert.doesNotThrow(() => c2.load());
  assert.ok(![...c2.roster.values()].some((i) => i.source === 'plugin'));
  // A home without any .claude: only built-in agents
  const c3 = new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: path.join(ROOT, 'none', '.claude'), homeDir: path.join(ROOT, 'none') });
  c3.load();
  assert.ok([...c3.roster.values()].every((i) => i.source === 'builtin'));
});

test('broad folders: home, Desktop, Documents and every drive root; no hard-coded personal path', () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: CLAUDE, homeDir: HOME });
  for (const p of [HOME, path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), 'C:\\', 'E:\\', 'z:']) {
    assert.equal(c.getProject(c.resolve(p, null)).broad, true, p);
  }
  assert.equal(c.getProject(c.resolve(P_LOG, null)).broad, false);
  assert.equal(c.getProject(c.resolve('D:\\Work', null)).broad, false, 'no hard-coded folder below a drive root is broad');
});

test('usage: a claude.ai skill invoked with a namespace attaches to that item; an unknown plugin skill gets the "plugin" source', () => {
  const { c } = build();
  const ing = new Ingest(c);
  ing.cutoff = 0;
  const t = Date.now();
  ing.bumpUsage(ing.usage.skills, 'account-namespace:cloud-skill', t, null, 'x');
  ing.bumpUsage(ing.usage.skills, 'sample-plugin:p-skill', t, null, 'y');
  ing.bumpUsage(ing.usage.skills, 'removed-plugin:old', t, null, 'z');
  ing.bumpUsage(ing.usage.skills, 'plain-unknown', t, null, 'w');
  const items = rosterView(ing, c);
  const byId = new Map(items.map((i) => [i.id, i]));
  assert.equal(byId.get('skill:cloud-skill').usage.count, 1);
  assert.equal(byId.has('skill:account-namespace:cloud-skill'), false, 'no fake plugin item');
  assert.equal(byId.get('skill:sample-plugin:p-skill').usage.count, 1);
  const gone = byId.get('skill:removed-plugin:old');
  assert.equal(gone.source, 'plugin');
  assert.deepEqual(gone.sources, ['plugin']);
  assert.equal(byId.get('skill:plain-unknown').source, 'other');
  const legacyNames = ['kutuphane', 'kisisel', 'proje', 'eklenti', 'yerlesik', 'diger', 'anthropic', 'cekirdek'];
  assert.ok(!items.some((i) => i.sources.some((s) => legacyNames.includes(s))), 'no Turkish or legacy source names');
});

test('frontmatter cache: a changed file is read again, the entry of a deleted file is dropped', () => {
  const home = path.join(ROOT, 'cache-home');
  const claude = path.join(home, '.claude');
  const file = path.join(claude, 'skills', 'folder', 'SKILL.md');
  write(file, fm('first-name'));
  const c = new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: claude, homeDir: home });
  c.load();
  assert.ok(item(c, 'skill', 'first-name'));
  c.load();
  assert.ok(item(c, 'skill', 'first-name'), 'an unchanged file gives the same result from the cache');
  write(file, fm('second-and-longer-name'));
  c.load();
  assert.ok(item(c, 'skill', 'second-and-longer-name'), 'a changed file is read again');
  assert.equal(item(c, 'skill', 'first-name'), undefined);
  assert.ok(c.fmCache.has(file));
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  c.load();
  assert.equal(item(c, 'skill', 'second-and-longer-name'), undefined);
  assert.equal(c.fmCache.has(file), false, 'the entry of a deleted file is dropped');
});

test('the real installed_plugins.json on this machine has the shape the parser expects (read-only, on request)', (t) => {
  // Tests are hermetic: the real home is read only when asked for (SIBERSENTEZ_REAL_MACHINE_TESTS=1)
  if (process.env.SIBERSENTEZ_REAL_MACHINE_TESTS !== '1') return t.skip('reads the real home; set SIBERSENTEZ_REAL_MACHINE_TESTS=1');
  const real = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(real)) return t.skip('no installed_plugins.json on this machine');
  let text = fs.readFileSync(real, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const j = JSON.parse(text);
  assert.equal(typeof j.version, 'number');
  assert.ok(j.plugins && typeof j.plugins === 'object' && !Array.isArray(j.plugins));
  for (const [id, entries] of Object.entries(j.plugins)) {
    assert.match(id, /^[^@]+@[^@]+$/, 'id is <name>@<marketplace>');
    assert.ok(Array.isArray(entries) && entries.length >= 1, 'array of install records');
    for (const e of entries) {
      assert.equal(typeof e.installPath, 'string');
      assert.equal(typeof e.scope, 'string');
    }
  }
});

// ---------------- discovery outside the log window (review finding A) ----------------
const DAY = 86400000;
function sessionFile(file, cwd, { daysAgo = 0, before = 3, filler = 200 } = {}) {
  const pad = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(filler) });
  const lines = [JSON.stringify({ type: 'bridge-session', sessionId: 's' }), ...Array.from({ length: before }, () => pad)];
  if (cwd) lines.push(JSON.stringify({ type: 'attachment', cwd, sessionId: 's' }));
  lines.push(pad);
  write(file, lines.join('\n') + '\n');
  const t = new Date(Date.now() - daysAgo * DAY);
  fs.utimesSync(file, t, t);
}

function discoveryWorld(name) {
  const home = path.join(ROOT, name);
  const claude = path.join(home, '.claude');
  const logs = path.join(claude, 'projects');
  return { home, claude, logs, catalog: () => new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: claude, homeDir: home }) };
}

const slash = (p) => String(p).replace(/\\/g, '/').toLowerCase();

test('discovery: a project whose last session is older than the log window is listed with its skills and agents', () => {
  const w = discoveryWorld('disco-old');
  const old = path.join(w.home, 'work', 'OldGame');
  skill(path.join(old, '.claude', 'skills'), 'old-skill');
  agent(path.join(old, '.claude', 'agents', 'old-agent.md'), 'old-agent');
  sessionFile(path.join(w.logs, 'C--work-OldGame', 'a.jsonl'), old, { daysAgo: 30 });
  const c = w.catalog();
  c.load();
  const s = item(c, 'skill', 'old-skill');
  assert.equal(s?.source, 'project', 'listed although its last session is 30 days old (default window: 14)');
  const p = c.getProject(s.installedIn[0]);
  assert.equal(p.kind, 'adhoc');
  assert.equal(path.resolve(p.path), path.resolve(old));
  assert.deepEqual(item(c, 'agent', 'old-agent').installedIn, [p.id]);
  assert.deepEqual(p.installed, { skills: 1, agents: 1 });
  const age = (Date.now() - p.lastSeenAt) / DAY;
  assert.ok(age > 29 && age < 31, `lastSeenAt is the newest session file time (${age} days)`);
  // It shows in the project list with its old activity
  const view = snapshot(new Ingest(c), c).projects.find((x) => x.id === p.id);
  assert.ok(view, 'in the project list');
  assert.equal(view.lastSeenAt, p.lastSeenAt);
  assert.equal(view.lastActivity, p.lastSeenAt);
  assert.equal(view.sessions, 0);
  assert.deepEqual(view.via, ['claude-code'], 'which tool reported it');
});

test('discovery: cwd comes from the head of the newest session file (older files tried when needed); some folders are skipped', () => {
  const w = discoveryWorld('disco-rules');
  const a = path.join(w.home, 'work', 'a');
  const b = path.join(w.home, 'work', 'b');
  const deep = path.join(w.home, 'work', 'deep');
  for (const [dir, n] of [
    [a, 'a-skill'],
    [b, 'b-skill'],
    [deep, 'deep-skill'],
  ]) skill(path.join(dir, '.claude', 'skills'), n);
  // The newest file of folder "f-a" points to a, an older one to b: the newest wins
  sessionFile(path.join(w.logs, 'f-a', 'new.jsonl'), a, { daysAgo: 1 });
  sessionFile(path.join(w.logs, 'f-a', 'old.jsonl'), b, { daysAgo: 20 });
  // The newest file has no cwd: the next one is used
  sessionFile(path.join(w.logs, 'f-b', 'new.jsonl'), null, { daysAgo: 1 });
  sessionFile(path.join(w.logs, 'f-b', 'old.jsonl'), b, { daysAgo: 2 });
  // cwd after long lines (beyond the first 64 KB chunk)
  sessionFile(path.join(w.logs, 'f-deep', 's.jsonl'), deep, { before: 40, filler: 3000 });
  // Skipped: memory only, a missing folder, a Claude scratchpad folder
  fs.mkdirSync(path.join(w.logs, 'f-memory', 'memory'), { recursive: true });
  sessionFile(path.join(w.logs, 'f-missing', 's.jsonl'), path.join(w.home, 'work', 'deleted'));
  const scratch = path.join(w.home, 'AppData', 'Local', 'Temp', 'claude', 'c--work-a', 'id', 'scratchpad');
  fs.mkdirSync(scratch, { recursive: true });
  sessionFile(path.join(w.logs, 'f-scratch', 's.jsonl'), scratch);
  const c = w.catalog();
  c.load();
  assert.ok(item(c, 'skill', 'a-skill'));
  assert.ok(item(c, 'skill', 'b-skill'));
  assert.ok(item(c, 'skill', 'deep-skill'), 'cwd found beyond the first chunk');
  const paths = c.allProjects().map((p) => p.path && slash(path.resolve(p.path)));
  assert.ok(!paths.includes(slash(path.join(w.home, 'work', 'deleted'))), 'a missing folder is not added');
  assert.ok(!c.allProjects().some((p) => p.tmpOnly || (p.path && slash(p.path).includes('/temp/claude/'))), 'no scratchpad project');
  assert.equal(c.discovered.size, 3);
  assert.ok(!c.memory.list().some((m) => slash(m.path).includes('/temp/claude/') || slash(m.path).includes('/deleted')), 'scratchpad and missing folders are not remembered');
});

test('discovery: a subfolder working directory mapped to a parent project is scanned too (items count for the parent)', () => {
  const w = discoveryWorld('disco-sub');
  const parent = path.join(w.home, 'work', 'Parent');
  const sub = path.join(parent, 'tools', 'sub');
  skill(path.join(parent, '.claude', 'skills'), 'parent-skill');
  skill(path.join(sub, '.claude', 'skills'), 'sub-skill');
  sessionFile(path.join(w.logs, 'a-parent', 's.jsonl'), parent, { daysAgo: 40 });
  sessionFile(path.join(w.logs, 'b-parent-sub', 's.jsonl'), sub, { daysAgo: 40 });
  const c = w.catalog();
  c.load();
  const pid = item(c, 'skill', 'parent-skill').installedIn[0];
  assert.deepEqual(item(c, 'skill', 'sub-skill')?.installedIn, [pid]);
  assert.deepEqual(c.getProject(pid).installed, { skills: 2, agents: 0 });
});

test('discovery cache: an unchanged log folder is not read again; a new session file refreshes it; a removed log folder leaves the cache but its project stays remembered', () => {
  const w = discoveryWorld('disco-cache');
  const one = path.join(w.home, 'work', 'one');
  const two = path.join(w.home, 'work', 'two');
  skill(path.join(one, '.claude', 'skills'), 'one-skill');
  skill(path.join(two, '.claude', 'skills'), 'two-skill');
  const folder = path.join(w.logs, 'f');
  sessionFile(path.join(folder, 's1.jsonl'), one, { daysAgo: 3 });
  const c = w.catalog();
  c.load();
  assert.ok(item(c, 'skill', 'one-skill'));
  // Rewriting a file in place does not change the folder time (as appending to a session does not): the
  // cached cwd is kept, the file is not read again
  const dirTime = fs.statSync(folder).mtimeMs;
  sessionFile(path.join(folder, 's1.jsonl'), two, { daysAgo: 3 });
  assert.equal(fs.statSync(folder).mtimeMs, dirTime, 'precondition: the folder time did not change');
  c.load();
  assert.ok(item(c, 'skill', 'one-skill'), 'cached');
  assert.equal(item(c, 'skill', 'two-skill'), undefined);
  // A new session file changes the folder time: read again, the newest file points to "two"
  sessionFile(path.join(folder, 's2.jsonl'), two, { daysAgo: 0 });
  assert.notEqual(fs.statSync(folder).mtimeMs, dirTime, 'precondition: the folder time changed');
  c.load();
  assert.ok(item(c, 'skill', 'two-skill'), 'refreshed');
  fs.rmSync(folder, { recursive: true, force: true });
  c.load();
  assert.equal(c.adapterCache.get('claude-code').folders.size, 0, 'removed log folders drop out of the adapter cache');
  assert.ok(item(c, 'skill', 'two-skill'), 'the project stays remembered (project memory)');
  assert.equal(c.discovered.size, 2);
});

// ---------------- linked folders and files (review finding C) ----------------
function link(target, at, type) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.symlinkSync(target, at, type);
    return true;
  } catch (e) {
    if (e.code === 'EPERM') return false; // file symlinks need developer mode or admin on Windows
    throw e;
  }
}

test('links: a junction-linked skill folder, agents folder and plugin skills folder are listed; a broken link is ignored', () => {
  const w = discoveryWorld('links-home');
  const ext = path.join(ROOT, 'links-external');
  skill(path.join(ext, 'skills'), 'linked-skill');
  agent(path.join(ext, 'agents', 'linked-agent.md'), 'linked-agent');
  link(path.join(ext, 'skills', 'linked-skill'), path.join(w.claude, 'skills', 'linked-skill'), 'junction');
  link(path.join(ext, 'agents'), path.join(w.claude, 'agents', 'team'), 'junction');
  link(path.join(ext, 'nowhere'), path.join(w.claude, 'skills', 'broken'), 'junction');
  const plug = path.join(w.claude, 'plugins', 'cache', 'm', 'lp', '1.0.0');
  link(path.join(ext, 'skills'), path.join(plug, 'skills'), 'junction');
  write(path.join(w.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'lp@m': [{ scope: 'user', installPath: plug, version: '1.0.0' }] } }));
  const c = w.catalog();
  assert.doesNotThrow(() => c.load());
  assert.equal(item(c, 'skill', 'linked-skill')?.source, 'personal');
  assert.equal(item(c, 'agent', 'linked-agent')?.source, 'personal');
  assert.equal(item(c, 'skill', 'broken'), undefined);
  assert.equal(item(c, 'skill', 'lp:linked-skill')?.source, 'plugin');
});

test('links: a link loop is followed once (no duplicates, no hang); a file symlink is listed when the OS allows it', (t) => {
  const w = discoveryWorld('links-loop');
  const proj = path.join(w.home, 'work', 'looped');
  const agents = path.join(proj, '.claude', 'agents');
  agent(path.join(agents, 'looped-agent.md'), 'looped-agent');
  link(agents, path.join(agents, 'again'), 'junction');
  sessionFile(path.join(w.logs, 'f', 's.jsonl'), proj);
  const c = w.catalog();
  c.load();
  const pid = item(c, 'agent', 'looped-agent').installedIn[0];
  assert.deepEqual(c.getProject(pid).installed, { skills: 0, agents: 1 }, 'the same folder is read once');
  const fileTarget = path.join(ROOT, 'links-external-file', 'solo.md');
  agent(fileTarget, 'solo-agent');
  if (!link(fileTarget, path.join(w.claude, 'agents', 'solo.md'), 'file')) return t.skip('file symlinks need developer mode or admin on this machine');
  c.load();
  assert.equal(item(c, 'agent', 'solo-agent')?.source, 'personal');
});

// ---------------- tool-independent discovery (review round 3) ----------------
const same = (a, b) => slash(path.resolve(a)) === slash(path.resolve(b));

test('resolveSlug: a folder name turns back into its single existing folder (spaces, dots, Turkish letters); ambiguous or missing -> null', () => {
  const base = path.join(ROOT, 'slug-world');
  const turkish = path.join(base, 'çalışma alanı');
  const dotted = path.join(base, 'my.app v2', 'inner dir');
  const ambA = path.join(base, 'amb a');
  const ambB = path.join(base, 'amb-a');
  for (const d of [turkish, dotted, ambA, ambB]) fs.mkdirSync(d, { recursive: true });
  const t0 = performance.now();
  assert.ok(same(resolveSlug(slugify(turkish)), turkish), 'Turkish letters and a space');
  assert.ok(same(resolveSlug(slugify(dotted)), dotted), 'a dot and nested folders');
  const ms = (performance.now() - t0) / 2;
  assert.ok(ms < 200, `a walk stays cheap (${ms.toFixed(1)} ms)`);
  assert.equal(resolveSlug(slugify(ambA)), null, '"amb a" and "amb-a" side by side: ambiguous, not accepted');
  assert.equal(resolveSlug(slugify(path.join(base, 'not-there'))), null, 'no such folder');
  for (const bad of ['', 'no-drive', 'C--', null]) assert.equal(resolveSlug(bad), null, JSON.stringify(bad));
  // Case does not matter (Claude Code keeps the case of the path it was started in)
  assert.ok(same(resolveSlug(slugify(turkish).toUpperCase()), turkish));
});

test('discovery: a log folder with only memory/ left (logs deleted) is resolved from its name; its project items are listed', () => {
  const w = discoveryWorld('memory-only');
  const proj = path.join(w.home, 'work', 'mobil uygulama.v2');
  skill(path.join(proj, '.claude', 'skills'), 'm-skill');
  agent(path.join(proj, '.claude', 'agents', 'm-agent.md'), 'm-agent');
  write(path.join(w.logs, slugify(proj), 'memory', 'MEMORY.md'), '# memory\n');
  // Ambiguous name: "amb x" and "amb-x" both exist, neither is accepted
  const ambA = path.join(w.home, 'work', 'amb x');
  const ambB = path.join(w.home, 'work', 'amb-x');
  skill(path.join(ambA, '.claude', 'skills'), 'amb-a-skill');
  skill(path.join(ambB, '.claude', 'skills'), 'amb-b-skill');
  write(path.join(w.logs, slugify(ambA), 'memory', 'MEMORY.md'), '# memory\n');
  // A name whose folder is gone
  write(path.join(w.logs, slugify(path.join(w.home, 'work', 'gone')), 'memory', 'MEMORY.md'), '# memory\n');
  const c = w.catalog();
  c.load();
  const s = item(c, 'skill', 'm-skill');
  assert.equal(s?.source, 'project');
  const p = c.getProject(s.installedIn[0]);
  assert.ok(same(p.path, proj));
  assert.deepEqual(item(c, 'agent', 'm-agent').installedIn, [p.id]);
  assert.deepEqual(p.via, ['claude-code']);
  assert.ok(p.lastSeenAt > 0, 'the log folder time stands in for the last session');
  assert.equal(item(c, 'skill', 'amb-a-skill'), undefined, 'ambiguous name not accepted');
  assert.equal(item(c, 'skill', 'amb-b-skill'), undefined);
  assert.equal(c.discovered.size, 1);
});

test('discovery: broad folders (home, a drive root, System32) never become remembered projects', () => {
  const w = discoveryWorld('broad-cwd');
  fs.mkdirSync(w.home, { recursive: true });
  sessionFile(path.join(w.logs, 'f-home', 's.jsonl'), w.home);
  sessionFile(path.join(w.logs, 'f-root', 's.jsonl'), 'C:\\');
  sessionFile(path.join(w.logs, 'f-sys', 's.jsonl'), 'C:\\Windows\\System32');
  const c = w.catalog();
  c.load();
  assert.equal(c.memory.size, 0, 'nothing remembered');
  assert.equal(c.allProjects().length, 0, 'no project from discovery');
});

test('readHeadCwd: a multi-byte character split across the 64 KB chunk border is decoded intact', () => {
  const file = path.join(ROOT, 'split-utf8', 's.jsonl');
  const cwd = 'C:\\work\\ş-folder';
  const prefix = JSON.stringify({ type: 'attachment', cwd }).split('ş')[0];
  // Line 1 ends so that the first byte of "ş" is the last byte of the first 64 KB chunk
  const border = 64 * 1024 - 1;
  const fillLen = border - Buffer.byteLength(prefix) - Buffer.byteLength('{"p":""}\n');
  const text = JSON.stringify({ p: 'a'.repeat(fillLen) }) + '\n' + JSON.stringify({ type: 'attachment', cwd }) + '\n';
  write(file, text);
  assert.equal(Buffer.from(text).indexOf(Buffer.from('ş')), border, 'precondition: the character straddles the border');
  assert.equal(readHeadCwd(file), cwd);
});

test('project memory: with a hub, discovered.json is written atomically next to (not into) the registry', () => {
  const hub = path.join(ROOT, 'mem-hub');
  initHub(hub);
  const registryText = fs.readFileSync(path.join(hub, 'registry', 'projects.json'), 'utf8');
  const w = discoveryWorld('mem-write');
  const proj = path.join(w.home, 'work', 'remembered');
  skill(path.join(proj, '.claude', 'skills'), 'r-skill');
  sessionFile(path.join(w.logs, 'f', 's.jsonl'), proj, { daysAgo: 5 });
  const memory = new ProjectMemory({ hubDir: hub, debounceMs: 0 });
  const c = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home, memory });
  c.load();
  const file = path.join(hub, 'registry', 'discovered.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.projects.length, 1);
  const e = data.projects[0];
  assert.ok(same(e.path, proj));
  assert.deepEqual(e.via, ['claude-code']);
  assert.ok(Date.parse(e.firstSeenAt) > 0 && Date.parse(e.lastSeenAt) > 0);
  assert.ok(Math.abs(Date.now() - Date.parse(e.lastSeenAt) - 5 * DAY) < DAY, 'lastSeenAt is the session time');
  assert.deepEqual(fs.readdirSync(path.join(hub, 'registry')).sort(), ['discovered.json', 'projects.json'], 'no temporary file left');
  assert.equal(fs.readFileSync(path.join(hub, 'registry', 'projects.json'), 'utf8'), registryText, 'the user registry is untouched');
  assert.equal(memory.saves, 1);
  c.load();
  assert.equal(memory.saves, 1, 'nothing new: no write');
});

test('project memory: after the log folder is deleted the project is still listed (new process, same hub); a deleted project folder is shown as missing', () => {
  const hub = path.join(ROOT, 'mem-hub-2');
  initHub(hub);
  const w = discoveryWorld('mem-survive');
  const proj = path.join(w.home, 'work', 'survivor');
  skill(path.join(proj, '.claude', 'skills'), 's-skill');
  agent(path.join(proj, '.claude', 'agents', 's-agent.md'), 's-agent');
  const logFolder = path.join(w.logs, 'f');
  sessionFile(path.join(logFolder, 's.jsonl'), proj, { daysAgo: 29 });
  const first = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home });
  first.load();
  first.memory.flush();
  // Claude Code deletes the old logs; the app starts again
  fs.rmSync(logFolder, { recursive: true, force: true });
  const second = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home });
  second.load();
  const s = item(second, 'skill', 's-skill');
  assert.equal(s?.source, 'project', 'still listed from the project memory');
  const p = second.getProject(s.installedIn[0]);
  assert.equal(p.kind, 'adhoc');
  assert.ok(same(p.path, proj));
  assert.deepEqual(p.via, ['claude-code']);
  assert.ok(item(second, 'agent', 's-agent'));
  // The project folder itself is deleted: the entry stays, shown as missing, nothing is listed from it
  fs.rmSync(proj, { recursive: true, force: true });
  second.load();
  const missing = second.allProjects().find((x) => x.path && same(x.path, proj));
  assert.ok(missing, 'still in the project list');
  assert.equal(missing.exists, false);
  assert.equal(item(second, 'skill', 's-skill'), undefined);
  const view = snapshot(new Ingest(second), second).projects.find((x) => x.id === missing.id);
  assert.equal(view.exists, false);
  // A fresh process lists the remembered but missing folder too
  second.memory.flush();
  const third = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home });
  third.load();
  const again = third.allProjects().find((x) => x.path && same(x.path, proj));
  assert.ok(again, 'listed after a restart');
  assert.equal(again.exists, false);
  second.memory.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(hub, 'registry', 'discovered.json'), 'utf8')).projects.length, 1, 'not deleted automatically');
  // Without a hub the memory lives in the process only
  const w2 = discoveryWorld('mem-nohub');
  const proj2 = path.join(w2.home, 'work', 'volatile');
  skill(path.join(proj2, '.claude', 'skills'), 'v-skill');
  const log2 = path.join(w2.logs, 'f');
  sessionFile(path.join(log2, 's.jsonl'), proj2);
  const c = w2.catalog();
  c.load();
  fs.rmSync(log2, { recursive: true, force: true });
  c.load();
  assert.ok(item(c, 'skill', 'v-skill'), 'remembered for the life of the process');
  assert.equal(c.memory.file, null);
  assert.equal(c.memory.flush(), false, 'nothing is written without a hub');
});

test('project memory: writes are debounced, a small lastSeenAt move is not written, a broken file is kept aside and rebuilt', () => {
  const hub = path.join(ROOT, 'mem-hub-3');
  initHub(hub);
  const file = path.join(hub, 'registry', 'discovered.json');
  let now = Date.UTC(2026, 8, 1);
  const m = new ProjectMemory({ hubDir: hub, debounceMs: 60000, now: () => now });
  m.record('C:\\a', { via: 'claude-code', lastSeenAt: now });
  m.record('C:\\b', { via: 'claude-code', lastSeenAt: now });
  m.record('C:\\a', { via: 'other-tool', lastSeenAt: now });
  assert.equal(fs.existsSync(file), false, 'nothing written before the debounce time');
  assert.equal(m.flush(), true);
  assert.equal(m.saves, 1, 'three changes, one write');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => [p.path, p.via]), [
    ['C:\\a', ['claude-code', 'other-tool']],
    ['C:\\b', ['claude-code']],
  ]);
  m.record('C:\\a', { via: 'claude-code', lastSeenAt: now + 10 * 60000 });
  assert.equal(m.flush(), false, 'ten minutes later: not worth a write');
  m.record('C:\\a', { via: 'claude-code', lastSeenAt: now + 2 * 3600000 });
  assert.equal(m.flush(), true, 'two hours later: written');
  // A broken file: no crash, kept aside, rebuilt on the next write
  fs.writeFileSync(file, '{broken');
  const logs = [];
  const r = new ProjectMemory({ hubDir: hub, debounceMs: 60000, log: (l) => logs.push(l) });
  assert.equal(r.size, 0);
  assert.equal(logs.length, 1);
  assert.equal(fs.readFileSync(file + '.broken', 'utf8'), '{broken');
  r.record('C:\\c', { via: 'claude-code', lastSeenAt: now });
  assert.equal(r.flush(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.path), ['C:\\c']);
  // Entries that are not objects or have no path are skipped when loading
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [null, { via: ['x'] }, { path: 'C:\\d', lastSeenAt: 'bad', via: 'x' }] }));
  const l = new ProjectMemory({ hubDir: hub });
  assert.deepEqual(l.list().map((e) => [e.path, e.via]), [['C:\\d', []]]);
});

test('project memory: a folder first remembered lower-cased takes its on-disk spelling when a later report gives exactly that (written); a lower-cased or wrongly cased report never replaces it', () => {
  const hub = path.join(ROOT, 'mem-hub-5');
  initHub(hub);
  const file = path.join(hub, 'registry', 'discovered.json');
  const proj = path.join(ROOT, 'Spelling Home', 'My Project');
  fs.mkdirSync(proj, { recursive: true });
  const proper = fs.realpathSync.native(proj); // the spelling on disk
  const lower = proper.toLowerCase();
  const wrong = proper.slice(0, 3) + proper.slice(3).toUpperCase();
  const m = new ProjectMemory({ hubDir: hub, debounceMs: 0 });
  m.record(lower, { via: 'gemini-cli' });
  assert.equal(m.list()[0].path, lower);
  const saves = m.saves;
  m.record(wrong, { via: 'gemini-cli' });
  assert.equal(m.list()[0].path, lower, 'a spelling that is not the on-disk one is not better');
  assert.equal(m.saves, saves, 'nothing to write');
  m.record(proper, { via: 'codex' });
  assert.equal(m.list()[0].path, proper);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.path), [proper], 'the better spelling is written');
  // A lower-cased report is never looked up on disk and never replaces the better spelling
  const orig = fs.realpathSync.native;
  let lookups = 0;
  fs.realpathSync.native = function (...a) {
    lookups++;
    return orig.apply(this, a);
  };
  try {
    m.record(lower, { via: 'gemini-cli' });
  } finally {
    fs.realpathSync.native = orig;
  }
  assert.equal(lookups, 0);
  assert.equal(m.list()[0].path, proper);
  // A new process reads the better spelling; an older file with a lower-cased spelling is corrected on the next report
  assert.equal(new ProjectMemory({ hubDir: hub }).list()[0].path, proper);
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: lower, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z', via: ['gemini-cli'] }] }));
  const r = new ProjectMemory({ hubDir: hub, debounceMs: 0 });
  r.record(proper, { via: 'gemini-cli' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.path), [proper]);
});

test('project memory: remembered broad or scratchpad folders (older file, hand edit) are not listed', () => {
  const hub = path.join(ROOT, 'mem-hub-4');
  initHub(hub);
  const w = discoveryWorld('mem-filter');
  fs.mkdirSync(w.home, { recursive: true });
  const scratch = path.join(w.home, 'AppData', 'Local', 'Temp', 'claude', 'c--x', 'id', 'scratchpad');
  fs.mkdirSync(scratch, { recursive: true });
  const ok = path.join(w.home, 'work', 'fine');
  fs.mkdirSync(ok, { recursive: true });
  const entry = (p) => ({ path: p, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z', via: ['claude-code'] });
  fs.writeFileSync(path.join(hub, 'registry', 'discovered.json'), JSON.stringify({ version: 1, projects: [entry(w.home), entry('C:\\'), entry(scratch), entry(ok)] }));
  const c = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home });
  c.load();
  assert.deepEqual(c.allProjects().map((p) => slash(p.path)), [slash(ok)]);
});

// VS Code-style workspace record as the editors write it (file:///c%3A/Users/...), in <APPDATA>/<app>/User/workspaceStorage
const fileUri = (p) => `file:///${p[0].toLowerCase()}%3A/${p.slice(3).split(/[\\/]/).map(encodeURIComponent).join('/')}`;
const editorRecord = (appData, app, hash, folder) => write(path.join(appData, app, 'User', 'workspaceStorage', hash, 'workspace.json'), JSON.stringify({ folder: fileUri(folder) }));

test('broad folders: <home>\\AppData and every folder below it never become projects from a tool record (not listed, not remembered); the temp rule and the scratchpad rule stay', { skip: WIN_ONLY }, () => {
  const hub = path.join(ROOT, 'appdata-hub');
  initHub(hub);
  const w = discoveryWorld('appdata-broad');
  const appData = path.join(w.home, 'AppData', 'Roaming'); // FAKE_ENV has no APPDATA: the editors live here
  const mk = (...p) => {
    const d = path.join(...p);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const editorInstall = mk(w.home, 'AppData', 'Local', 'Programs', 'Antigravity IDE');
  const gameSaves = mk(appData, 'SomeGame', 'Saves');
  const lowSaves = mk(w.home, 'AppData', 'LocalLow', 'Studio', 'Game');
  const appDataItself = path.join(w.home, 'AppData');
  const inTemp = mk(w.home, 'AppData', 'Local', 'Temp', 'some-clone'); // the temp rule: a working folder inside Temp stays a project
  const real = mk(w.home, 'work', 'real-project');
  const cased = mk(w.home, 'work', 'other-project');
  // An editor (Cursor) remembers each of them as a workspace; one record spells AppData in another case
  editorRecord(appData, 'Cursor', 'h1', editorInstall);
  editorRecord(appData, 'Cursor', 'h2', gameSaves);
  editorRecord(appData, 'Cursor', 'h3', lowSaves);
  editorRecord(appData, 'Cursor', 'h4', appDataItself);
  editorRecord(appData, 'Cursor', 'h5', inTemp);
  editorRecord(appData, 'Cursor', 'h6', real);
  editorRecord(appData, 'Cursor', 'h7', path.join(w.home, 'APPDATA', 'Local', 'Programs', 'Antigravity IDE'));
  editorRecord(appData, 'Cursor', 'h8', cased);
  // Claude Code was also started once in the editor's install folder
  sessionFile(path.join(w.logs, slugify(editorInstall), 's.jsonl'), editorInstall);
  const memory = new ProjectMemory({ hubDir: hub, debounceMs: 0 });
  const c = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home, memory });
  c.load();
  const want = [real, cased, inTemp].map(slash).sort();
  assert.deepEqual(c.allProjects().map((p) => slash(p.path)).sort(), want, 'project list');
  assert.deepEqual(c.memory.list().map((m) => slash(m.path)).sort(), want, 'project memory');
  const file = JSON.parse(fs.readFileSync(path.join(hub, 'registry', 'discovered.json'), 'utf8'));
  assert.deepEqual(file.projects.map((p) => slash(p.path)).sort(), want, 'nothing below AppData is written to discovered.json');
  assert.ok(c.allProjects().every((p) => p.via.includes('cursor')), 'the other records of the same editor still count');
  // The rule itself: AppData and below are broad (so no install or suggestion goes there either), Temp itself too;
  // a folder inside Temp, a sibling folder that only starts with the same letters and ordinary folders are not
  for (const p of [appDataItself, editorInstall, gameSaves, lowSaves, path.join(w.home, 'AppData', 'Local', 'Temp')]) assert.equal(c.isBroad(normPath(p)), true, p);
  for (const p of [inTemp, real, path.join(w.home, 'AppDataBackup'), path.join(w.home, 'work', 'AppData')]) assert.equal(c.isBroad(normPath(p)), false, p);
  assert.equal(c.isProjectFolder(editorInstall), false);
  // A home made inside the temp folder (as in this test, and as a test run of the app uses): the temp folder that
  // holds it carves nothing out of its AppData; only the temp folder inside AppData keeps its working folders
  assert.ok(normPath(w.home).startsWith(normPath(os.tmpdir()) + '/'), 'precondition: the fake home lies inside the temp folder');
  const inTempEnv = new Catalog({ env: { TEMP: os.tmpdir(), TMP: os.tmpdir() }, hubDir: null, claudeDir: w.claude, homeDir: w.home });
  for (const p of [editorInstall, gameSaves, lowSaves]) assert.equal(inTempEnv.isBroad(normPath(p)), true, p);
  assert.equal(inTempEnv.isBroad(normPath(inTemp)), false);
  assert.equal(inTempEnv.isBroad(normPath(real)), false);
  inTempEnv.load();
  assert.ok(!inTempEnv.allProjects().some((p) => slash(p.path).startsWith(slash(path.join(w.home, 'AppData')) + '/') && slash(p.path) !== slash(inTemp)), 'no AppData folder is a project');
  // A live Claude Code session in such a folder is shown as a broad folder (no action, no install), like the home folder
  const live = c.getProject(c.resolve(gameSaves, null));
  assert.equal(live.broad, true);
  // Claude Code's scratchpad under Temp\claude still belongs to the project whose name it carries
  const scratch = path.join(w.home, 'AppData', 'Local', 'Temp', 'claude', slugify(real).toLowerCase(), 'id', 'scratchpad');
  const owner = c.getProject(c.resolve(scratch, null));
  assert.ok(owner && slash(owner.path) === slash(real), 'the scratchpad maps to its project');
  assert.equal(owner.broad, false);
});

test('project memory: a remembered folder below <home>\\AppData (older file, hand edit) is not listed', { skip: WIN_ONLY }, () => {
  const hub = path.join(ROOT, 'appdata-hub-2');
  initHub(hub);
  const w = discoveryWorld('appdata-memory');
  const inApp = path.join(w.home, 'AppData', 'Local', 'Programs', 'Editor');
  const ok = path.join(w.home, 'work', 'fine');
  for (const d of [inApp, ok]) fs.mkdirSync(d, { recursive: true });
  const entry = (p) => ({ path: p, firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-01T00:00:00.000Z', via: ['cursor'] });
  fs.writeFileSync(path.join(hub, 'registry', 'discovered.json'), JSON.stringify({ version: 1, projects: [entry(inApp), entry(ok)] }));
  const c = new Catalog({ env: FAKE_ENV, hubDir: hub, claudeDir: w.claude, homeDir: w.home });
  c.load();
  assert.deepEqual(c.allProjects().map((p) => slash(p.path)), [slash(ok)]);
});

test('project items: a personal .claude that sits inside a remembered project folder is not counted again as project items', () => {
  const w = discoveryWorld('claude-inside-project');
  const proj = path.join(w.home, 'work', 'holder');
  const claude = path.join(proj, '.claude'); // CLAUDE_CONFIG_DIR pointing into a project folder
  skill(path.join(claude, 'skills'), 'personal-here');
  sessionFile(path.join(claude, 'projects', 'f', 's.jsonl'), proj);
  const c = new Catalog({ env: FAKE_ENV, hubDir: null, claudeDir: claude, homeDir: w.home });
  c.load();
  const s = item(c, 'skill', 'personal-here');
  assert.equal(s?.source, 'personal');
  assert.deepEqual(s.sources, ['personal']);
  assert.deepEqual(s.installedIn, []);
});

// ---------------- roster counts and folder filter (client model, public/js/rosterModel.js) ----------------
// The library count counts copies once, every roster item is listed under the folders it sits in (personalDirs above
// feeds the personal folders), and the folder filter selects them. Pure functions, no DOM.

// A small machine: library items (two categories), a personal skill that is also in the library, project items,
// plugin skills with the same base name in two plugins, claude.ai synced skills and plugins, built-in and log items
function folderRoster() {
  return [
    { id: 'skill:lint', kind: 'skill', name: 'lint', source: 'library', sources: ['library', 'project'], category: 'testing', installedIn: ['p-web'] },
    { id: 'skill:deploy', kind: 'skill', name: 'deploy', source: 'library', sources: ['library'], category: 'devops', installedIn: [] },
    { id: 'agent:reviewer', kind: 'agent', name: 'reviewer', source: 'library', sources: ['library'], category: 'testing', installedIn: [] },
    { id: 'skill:notes', kind: 'skill', name: 'notes', source: 'personal', sources: ['personal', 'library'], category: 'docs', personalDirs: ['~/.agents/skills', '~/.claude/skills'], installedIn: [] },
    { id: 'agent:helper', kind: 'agent', name: 'helper', source: 'personal', sources: ['personal'], category: 'personal', personalDirs: ['~/.claude/agents'], installedIn: [] },
    { id: 'skill:old-personal', kind: 'skill', name: 'old-personal', source: 'personal', sources: ['personal'], category: 'personal', installedIn: [] },
    { id: 'skill:build', kind: 'skill', name: 'build', source: 'project', sources: ['project'], category: 'project', installedIn: ['p-web', 'p-game'] },
    { id: 'agent:level-designer', kind: 'agent', name: 'level-designer', source: 'project', sources: ['project'], category: 'project', installedIn: ['p-game'] },
    { id: 'plugin:gh', kind: 'plugin', name: 'gh', source: 'plugin', sources: ['plugin'], category: 'market', pluginId: 'gh@market', enabled: true, installedIn: [] },
    { id: 'skill:gh:start', kind: 'skill', name: 'gh:start', source: 'plugin', sources: ['plugin'], category: 'gh', plugin: 'gh@market', enabled: true, installedIn: [] },
    { id: 'agent:gh:bot', kind: 'agent', name: 'gh:bot', source: 'plugin', sources: ['plugin'], category: 'gh', plugin: 'gh@market', enabled: true, installedIn: [] },
    { id: 'skill:Zoom:start', kind: 'skill', name: 'Zoom:start', source: 'claudeai', sources: ['claudeai'], category: 'claudeai', plugin: 'Zoom@knowledge', enabled: true, installedIn: [] },
    { id: 'plugin:zoom', kind: 'plugin', name: 'Zoom', source: 'claudeai', sources: ['claudeai'], category: 'claudeai', pluginId: 'Zoom@knowledge', enabled: true, installedIn: [] },
    { id: 'skill:synced-one', kind: 'skill', name: 'synced-one', source: 'claudeai', sources: ['claudeai'], category: 'claudeai', installedIn: [] },
    { id: 'agent:explore', kind: 'agent', name: 'Explore', source: 'builtin', sources: ['builtin'], category: 'builtin', installedIn: [] },
    { id: 'skill:ext:tool', kind: 'skill', name: 'ext:tool', source: 'plugin', sources: ['plugin'], category: 'ext', installedIn: [] },
    { id: 'agent:ghost', kind: 'agent', name: 'ghost', source: 'other', sources: ['other'], category: 'other', installedIn: [] },
  ];
}
const byId = (r, id) => r.find((i) => i.id === id);

test('baseName and copyKey: the namespace is dropped, the kind kept, case ignored', () => {
  assert.equal(baseName('zoom-plugin:start'), 'start');
  assert.equal(baseName('a:b:c'), 'c');
  assert.equal(baseName('plain'), 'plain');
  assert.equal(baseName(null), '');
  assert.equal(copyKey({ kind: 'skill', name: 'Zoom:Start' }), 'skill:start');
  assert.equal(copyKey({ kind: 'skill', name: 'start' }), copyKey({ kind: 'skill', name: 'gh:start' }));
  assert.notEqual(copyKey({ kind: 'skill', name: 'start' }), copyKey({ kind: 'agent', name: 'start' }));
});

test('libraryCounts: only library skills and agents (a second source counts too); copies once; plugins never', () => {
  const r = folderRoster();
  assert.deepEqual(libraryCounts(r), { skill: 3, agent: 1, total: 4 });
  // The same kind and name twice (another spelling, a namespaced copy) counts once; another kind does not merge
  const copies = [
    ...r,
    { kind: 'skill', name: 'LINT', source: 'library', sources: ['library'], category: 'web' },
    { kind: 'skill', name: 'extra:lint', source: 'library', sources: ['library'], category: 'web' },
    { kind: 'agent', name: 'lint', source: 'library', sources: ['library'], category: 'web' },
    { kind: 'plugin', name: 'lib-plugin', source: 'library', sources: ['library'] },
  ];
  assert.deepEqual(libraryCounts(copies), { skill: 3, agent: 2, total: 5 });
  assert.deepEqual(libraryCounts(r.filter((i) => !i.sources.includes('library'))), { skill: 0, agent: 0, total: 0 }, 'an empty library is 0, whatever else is on the machine');
  assert.deepEqual(libraryCounts([]), { skill: 0, agent: 0, total: 0 });
  assert.deepEqual(libraryCounts(null), { skill: 0, agent: 0, total: 0 });
  // Legacy source spelling still reads as the library
  assert.deepEqual(libraryCounts([{ kind: 'skill', name: 'x', source: 'kutuphane' }]), { skill: 1, agent: 0, total: 1 });
});

test('foldersOf: library category, every project, personal folders, the plugin, claude.ai, built-in, logs', () => {
  const r = folderRoster();
  assert.deepEqual(foldersOf(byId(r, 'skill:lint')), ['lib:testing', 'proj:p-web']);
  assert.deepEqual(foldersOf(byId(r, 'skill:notes')), ['lib:docs', 'home:~/.agents/skills', 'home:~/.claude/skills'], 'a personal skill in two folders is listed under both');
  assert.deepEqual(foldersOf(byId(r, 'skill:old-personal')), ['home:'], 'no personalDirs (older server): one personal folder');
  assert.deepEqual(foldersOf(byId(r, 'skill:build')), ['proj:p-web', 'proj:p-game']);
  assert.deepEqual(foldersOf(byId(r, 'plugin:gh')), ['plugin:gh'], 'a plugin is its own folder');
  assert.deepEqual(foldersOf(byId(r, 'skill:gh:start')), ['plugin:gh'], 'the @marketplace part is dropped');
  assert.deepEqual(foldersOf(byId(r, 'skill:Zoom:start')), ['plugin:zoom'], 'a plugin synced from claude.ai sits under its plugin, lower-cased key');
  assert.deepEqual(foldersOf(byId(r, 'plugin:zoom')), ['plugin:zoom']);
  assert.deepEqual(foldersOf(byId(r, 'skill:synced-one')), ['claudeai']);
  assert.deepEqual(foldersOf(byId(r, 'agent:explore')), ['builtin']);
  assert.deepEqual(foldersOf(byId(r, 'skill:ext:tool')), ['plugin:ext'], 'no plugin field: the namespace of the name');
  assert.deepEqual(foldersOf(byId(r, 'agent:ghost')), ['other']);
  assert.deepEqual(foldersOf({ kind: 'skill', name: 'x', source: 'project', installedIn: [] }), ['other'], 'no known place: other');
  assert.deepEqual(foldersOf(null), []);
  const it = byId(r, 'skill:lint');
  assert.equal(foldersOf(it), foldersOf(it), 'cached per item');
  assert.equal(folderGroupOf('lib:web'), 'library');
  assert.equal(folderGroupOf('proj:x'), 'projects');
  assert.equal(folderGroupOf('home:~/.claude/skills'), 'personal');
  assert.equal(folderGroupOf('plugin:gh'), 'plugins');
  assert.equal(folderGroupOf('claudeai'), 'more');
  assert.equal(folderGroupOf('nope'), null);
});

test('folder filter: a folder lists what is in it; a group lists every folder of it; combines with kind and search', () => {
  const r = folderRoster();
  const ids = (folder, f = {}) => r.filter((i) => matchesFilter(i, { ...f, folder })).map((i) => i.id);
  assert.equal(ids('all').length, r.length);
  assert.deepEqual(ids('lib:testing'), ['skill:lint', 'agent:reviewer']);
  assert.deepEqual(ids('proj:p-game'), ['skill:build', 'agent:level-designer']);
  assert.deepEqual(ids('proj:p-game', { kind: 'agent' }), ['agent:level-designer'], 'which agents are in this folder');
  assert.deepEqual(ids('home:~/.claude/skills'), ['skill:notes']);
  assert.deepEqual(ids('plugin:gh'), ['plugin:gh', 'skill:gh:start', 'agent:gh:bot']);
  assert.deepEqual(ids('group:library'), ['skill:lint', 'skill:deploy', 'agent:reviewer', 'skill:notes']);
  assert.deepEqual(ids('group:personal'), ['skill:notes', 'agent:helper', 'skill:old-personal']);
  assert.deepEqual(ids('group:plugins', { q: 'start' }), ['skill:gh:start', 'skill:Zoom:start']);
  assert.deepEqual(ids('claudeai'), ['skill:synced-one']);
  assert.deepEqual(ids('proj:gone'), [], 'a folder that is not there lists nothing');
  assert.equal(matchesFolder(byId(r, 'skill:lint'), ''), true);
  assert.equal(matchesFolder(byId(r, 'skill:lint'), 'group:more'), false);
});

test('folderIndex: counts per folder by kind, copies once, only items matching the other filters; folderCounts for one key', () => {
  const r = folderRoster();
  const idx = folderIndex(r);
  assert.deepEqual(idx.get('lib:testing').counts, { skill: 1, agent: 1, plugin: 0, total: 2 });
  assert.deepEqual(idx.get('plugin:gh').counts, { skill: 1, agent: 1, plugin: 1, total: 3 });
  assert.equal(idx.get('plugin:zoom').name, 'Zoom', 'the plugin keeps its own spelling for display');
  assert.equal(idx.get('proj:p-web').name, 'p-web');
  assert.equal(idx.get('home:~/.claude/skills').group, 'personal');
  assert.deepEqual([...idx.keys()].sort(), ['builtin', 'claudeai', 'home:', 'home:~/.agents/skills', 'home:~/.claude/agents', 'home:~/.claude/skills', 'lib:devops', 'lib:docs', 'lib:testing', 'other', 'plugin:ext', 'plugin:gh', 'plugin:zoom', 'proj:p-game', 'proj:p-web']);
  // Filtered: agents only; the filter's own folder is ignored (every folder is counted)
  const agents = folderIndex(r, { kind: 'agent', folder: 'lib:testing' });
  assert.deepEqual([...agents.keys()].sort(), ['builtin', 'home:~/.claude/agents', 'lib:testing', 'other', 'plugin:gh', 'proj:p-game']);
  assert.equal(agents.get('lib:testing').counts.total, 1);
  // Copies in one folder count once
  const dup = [...r, { kind: 'skill', name: 'other:start', source: 'plugin', sources: ['plugin'], plugin: 'gh@market', installedIn: [] }];
  assert.equal(folderIndex(dup).get('plugin:gh').counts.skill, 1);
  // One key or a whole group, copies once (gh:start and Zoom:start are one skill "start")
  assert.deepEqual(folderCounts(r, 'group:plugins'), { skill: 2, agent: 1, plugin: 2, total: 5 });
  assert.deepEqual(folderCounts(r, 'proj:p-web'), { skill: 2, agent: 0, plugin: 0, total: 2 });
  assert.deepEqual(folderCounts(r, 'nowhere'), { skill: 0, agent: 0, plugin: 0, total: 0 });
});

test('folderGroups: every group in order (empty ones too), folders sorted by label, the single folders in a fixed order', () => {
  const r = folderRoster();
  const groups = folderGroups(folderIndex(r).values());
  assert.deepEqual(groups.map((g) => g.key), FOLDER_GROUPS);
  const keys = (g) => groups.find((x) => x.key === g).folders.map((e) => e.key);
  assert.deepEqual(keys('library'), ['lib:devops', 'lib:docs', 'lib:testing']);
  assert.deepEqual(keys('projects'), ['proj:p-game', 'proj:p-web']);
  assert.deepEqual(keys('plugins'), ['plugin:ext', 'plugin:gh', 'plugin:zoom']);
  assert.deepEqual(keys('more'), ['claudeai', 'builtin', 'other']);
  // A label function decides the order (project names instead of ids)
  const names = { 'proj:p-web': 'Anthill', 'proj:p-game': 'Zebra' };
  const g2 = folderGroups(folderIndex(r).values(), (e) => names[e.key] || e.name);
  assert.deepEqual(g2.find((x) => x.key === 'projects').folders.map((e) => e.key), ['proj:p-web', 'proj:p-game']);
  const empty = folderGroups([]);
  assert.deepEqual(empty.map((g) => [g.key, g.folders.length]), FOLDER_GROUPS.map((g) => [g, 0]));
});

test('parseFolder and sourceFolder: known shapes only; the older ?source= values map to their group', () => {
  assert.equal(parseFolder('lib:web'), 'lib:web');
  assert.equal(parseFolder('proj:x-c-demo'), 'proj:x-c-demo');
  assert.equal(parseFolder('home:~/.claude/skills'), 'home:~/.claude/skills');
  assert.equal(parseFolder('group:plugins'), 'group:plugins');
  assert.equal(parseFolder('group:more'), 'all', 'the "other" group is not selectable as a whole');
  assert.equal(parseFolder('group:nope'), 'all');
  assert.equal(parseFolder('builtin'), 'builtin');
  assert.equal(parseFolder('web'), 'all');
  assert.equal(parseFolder(''), 'all');
  assert.equal(parseFolder(null), 'all');
  assert.equal(parseFolder('lib:' + 'x'.repeat(400)), 'all');
  assert.equal(parseFolder('lib:a\nb'), 'all');
  assert.equal(sourceFolder('library'), 'group:library');
  assert.equal(sourceFolder('kutuphane'), 'group:library', 'legacy spelling');
  assert.equal(sourceFolder('project'), 'group:projects');
  assert.equal(sourceFolder('plugin'), 'group:plugins');
  assert.equal(sourceFolder('personal'), 'group:personal');
  assert.equal(sourceFolder('claudeai'), 'claudeai');
  assert.equal(sourceFolder('other'), 'other');
  assert.equal(sourceFolder('whatever'), 'all', 'an unknown source does not become "other"');
  assert.equal(sourceFolder('all'), 'all');
  assert.equal(sourceFolder(undefined), 'all');
});

test('kit in the roster model: its own folder group (kit:<kit category>), its own count beside the library count, its label and hint; the library count stays the user library', async () => {
  const { kitCounts, isKitItem, sourceLabel, sourcesOf, accessText, SOURCE_HINT, sourceCounts } = await import('../public/js/rosterModel.js');
  const { setLanguage } = await import('../public/js/i18n.js');
  setLanguage('tr'); // the Turkish texts are asserted below; English is checked at the end
  const r = [
    ...folderRoster(),
    { id: 'skill:idea-to-plan', kind: 'skill', name: 'idea-to-plan', source: 'kit', sources: ['kit'], category: 'planning', kitCategory: 'planning', installedIn: [] },
    { id: 'agent:tester', kind: 'agent', name: 'tester', source: 'kit', sources: ['kit', 'project'], category: 'quality', kitCategory: 'quality', installedIn: ['p-web'] },
    // In the user library and the kit: the library category, and the kit folder it also sits in
    { id: 'skill:mixed', kind: 'skill', name: 'mixed', source: 'library', sources: ['library', 'kit'], category: 'testing', kitCategory: 'quality', installedIn: [] },
  ];
  assert.deepEqual(foldersOf(byId(r, 'skill:idea-to-plan')), ['kit:planning']);
  assert.deepEqual(foldersOf(byId(r, 'agent:tester')), ['kit:quality', 'proj:p-web']);
  assert.deepEqual(foldersOf(byId(r, 'skill:mixed')), ['lib:testing', 'kit:quality']);
  assert.equal(folderGroupOf('kit:planning'), 'kit');
  assert.deepEqual(FOLDER_GROUPS, ['library', 'kit', 'projects', 'personal', 'plugins', 'more']);
  const groups = folderGroups(folderIndex(r).values());
  assert.deepEqual(groups.find((g) => g.key === 'kit').folders.map((e) => e.key), ['kit:planning', 'kit:quality']);
  const ids = (folder) => r.filter((i) => matchesFilter(i, { folder })).map((i) => i.id);
  assert.deepEqual(ids('group:kit'), ['skill:idea-to-plan', 'agent:tester', 'skill:mixed']);
  assert.deepEqual(ids('kit:quality'), ['agent:tester', 'skill:mixed']);
  assert.equal(parseFolder('group:kit'), 'group:kit');
  assert.equal(parseFolder('kit:planning'), 'kit:planning');
  assert.equal(sourceFolder('kit'), 'group:kit');
  // Counts: the kit apart, the library count only the user's own (the mixed item is in both)
  assert.deepEqual(kitCounts(r), { skill: 2, agent: 1, total: 3 });
  assert.deepEqual(libraryCounts(r), { skill: 4, agent: 1, total: 5 });
  assert.equal(sourceCounts(r).kit, 3, 'counted, never NaN');
  // Label, hint and access text: in the kit until installed, never "every project"
  assert.equal(sourceLabel('kit'), 'SiberSentez seti');
  assert.deepEqual(sourcesOf(byId(r, 'agent:tester')), ['kit', 'project']);
  assert.ok(SOURCE_HINT.kit);
  assert.equal(isKitItem(byId(r, 'skill:idea-to-plan')), true);
  assert.equal(isKitItem(byId(r, 'skill:lint')), false);
  assert.equal(accessText(byId(r, 'skill:idea-to-plan')), 'SiberSentez setinde; bir projeye kurulmaya hazır.');
  assert.equal(accessText(byId(r, 'agent:tester')), 'Yalnız kurulu olduğu projede geçerli.');
  setLanguage('en');
  assert.equal(sourceLabel('kit'), 'SiberSentez kit');
  assert.equal(accessText(byId(r, 'skill:idea-to-plan')), 'In the SiberSentez kit; ready to be installed in a project.');
});

test('reload without the roster: the projects are read again, the skill and agent scan is left for its own turn (docs/backlog.md "Long-running load")', () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  let scans = 0;
  const real = c.loadRoster.bind(c);
  c.loadRoster = () => (scans++, real());
  c.load();
  assert.equal(scans, 1);
  const v = c.version;
  c.load({ roster: false });
  assert.equal(scans, 1, 'no roster scan');
  assert.equal(c.version, v + 1, 'still a new version: the projects were read again');
  c.load();
  assert.equal(scans, 2);
  const index = fs.readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.ok(index.includes('reloadCatalog({ roster: false });') && index.includes('if (roster) catalog.loadRosterInSteps().then((changed) => changed && publishCatalog())') && index.includes('const ROSTER_EVERY = 5;'));
});

test('a reload of the projects keeps their skill and agent counts (the roster scan writes them only every fifth time)', () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  c.load();
  const before = new Map(c.projects.map((p) => [p.id, p.installed]));
  assert.ok([...before.values()].every(Boolean), 'counted by the scan');
  c.load({ roster: false });
  for (const p of c.projects) assert.deepEqual(p.installed, before.get(p.id), p.id);
});

test('Claude Code reads its global items in parts: its own and claude.ai skills, one part per plugin, the built-in agents', () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  const cc = c.adapters.find((a) => a.id === 'claude-code');
  const parts = [...cc.globalItemSteps(c.adapterCtx(cc))];
  assert.deepEqual(parts.flat(), cc.findGlobalItems(c.adapterCtx(cc)));
  // cloud and cloud-off synced; sample-plugin and disabled installed (the others have no folder)
  assert.equal(parts.length, 6);
  assert.ok(parts[0].some((i) => i.source === 'personal') && parts[0].some((i) => i.source === 'claudeai') && parts[0].every((i) => i.kind !== 'plugin'));
  assert.deepEqual(parts.slice(1, 5).map((p) => p[0].kind === 'plugin' && p.filter((i) => i.kind === 'plugin').length === 1), [true, true, true, true], 'one plugin, then its items');
  assert.deepEqual(parts.slice(1, 3).map((p) => p[0].name).sort(), ['cloud', 'cloud-off'], 'the synced ones (in folder order)');
  assert.deepEqual(parts.slice(3, 5).map((p) => p[0].name), ['sample-plugin', 'disabled'], 'then the installed ones');
  assert.ok(parts[5].length && parts[5].every((i) => i.source === 'builtin'));
});

test('a tool that reads in parts: the loop comes back inside a long read, the same items, a failing part keeps the ones before', async () => {
  const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
  const item = (name) => ({ kind: 'skill', name, path: null, source: 'plugin', category: 'plugin', global: true });
  let broken = false;
  const parted = {
    id: 'parted',
    name: 'Parted',
    detect: () => true,
    findProjects: () => [],
    findGlobalItems: (ctx) => [...parted.globalItemSteps(ctx)].flat(),
    *globalItemSteps() {
      for (const n of ['p1', 'p2', 'p3']) {
        busy(STEP_MS + 4);
        if (broken && n === 'p3') throw new Error('unreadable plugin');
        yield [item(n)];
      }
    },
  };
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME, adapters: [parted] });
  c.load();
  const whole = JSON.stringify([...c.roster.entries()]);
  let pauses = 0;
  await c.loadRosterInSteps({ pause: async () => void pauses++ });
  assert.ok(pauses >= 4, `inside the read too (${pauses} pauses)`);
  assert.equal(JSON.stringify([...c.roster.entries()]), whole, 'the same items as in one piece');
  broken = true;
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    c.loadRoster();
    c.loadRoster();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(['p1', 'p2', 'p3'].map((n) => c.roster.has(`skill:${n}`)), [true, true, false], 'the parts before the failing one stay');
  assert.equal(errors.filter((m) => m.includes('parted.globalItemSteps failed')).length, 1, 'said once');
});

test('the roster in steps: the same answer as one piece, nothing seen half done, a full scan meanwhile wins, one at a time', async () => {
  const c = new Catalog({ env: FAKE_ENV, hubDir: HUB, claudeDir: CLAUDE, homeDir: HOME });
  c.load();
  const whole = JSON.stringify([...c.roster.entries()]);
  const counts = JSON.stringify(c.allProjects().map((p) => [p.id, p.installed]));
  // In steps, with a look at the catalog between every two: always the old roster or the new one, never a mix
  const before = c.roster;
  let pauses = 0;
  const changed = await c.loadRosterInSteps({
    pause: async () => {
      pauses++;
      assert.equal(c.roster, before, 'the old roster until the end');
      assert.equal(c.lister, null, 'no lister of the pass left on the catalog between steps');
    },
  });
  assert.equal(changed, true);
  assert.ok(pauses >= 2, `it gave the loop back (${pauses} times)`);
  assert.notEqual(c.roster, before);
  assert.equal(JSON.stringify([...c.roster.entries()]), whole, 'the same items as the scan in one piece');
  assert.equal(JSON.stringify(c.allProjects().map((p) => [p.id, p.installed])), counts, 'the same counts');
  // A full scan (an action) between two steps: it wins, the stepping one ends without changing anything
  let ran = false;
  let kept = null;
  const stepping = c.loadRosterInSteps({
    pause: async () => {
      if (ran) return;
      ran = true;
      c.loadRoster();
      kept = c.roster;
    },
  });
  // One at a time: a second stepping scan while one runs does nothing
  assert.equal(await c.loadRosterInSteps(), false);
  assert.equal(await stepping, false);
  assert.equal(c.roster, kept, 'the full scan\'s roster stays');
  // Once the full scan won, the stepping one stops at its next step (it does not read the rest for nothing)
  let after = 0;
  let won = false;
  await c.loadRosterInSteps({
    pause: async () => {
      if (won) after++;
      if (!won) {
        won = true;
        c.loadRoster();
      }
    },
  });
  assert.equal(after, 0, 'no step after the full scan won');
});
