// Skill flow tests: install, remove, try and the action surface of the six new actions (docs/skills-flow.md §3, §4,
// §6). Run: node --test test/install.test.mjs
// Hermetic: a fake hub, a fake home and fake projects under the system temp folder; no real process is started
// (spawn is injected), the real home, hub and projects are never read or written.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createActions, ACTION_NAMES, SKILL_ACTIONS, LAUNCH_ACTIONS, MAX_SKILL_ITEMS } from '../server/actions.mjs';
import { createHandler } from '../server/app.mjs';
import { PUBLIC_DIR } from '../server/config.mjs';
import { initHub } from '../server/hub.mjs';
import { Catalog } from '../server/catalog.mjs';
import { treeHash, listLibrary, realPath, LEFTOVER_RE } from '../server/library.mjs';
import { defaultTargets, planInstall, executeInstall, planRemove, executeRemove, resolveProject, isBroadFolder, destination, readInstalls, cleanupTrials, sweepLeftovers, trialName, TRIAL_MARKER, TARGETS } from '../server/install.mjs';
import { skillTargets, libraryInstallable, suggestFlowView, installTargets, itemInstallView, defaultSuggestSelection, selectionKey, planRows, skillErrorText, importBatches } from '../public/js/contextmenu.js';
import { initActions, runAction, actionBody, _resetActionsForTest } from '../public/js/actions.js';
import { STRINGS as PAGE_STRINGS, setLanguage } from '../public/js/i18n.js';

// ---------------- fake world ----------------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-install-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const fm = (name, description = `${name} description`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const exists = (p) => fs.existsSync(p);
const junction = (target, at) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
};

let worldN = 0;
// A fresh hub with a small library and three projects (one per tool family) for every test
function world({ legacy = false } = {}) {
  const base = path.join(ROOT, `w${++worldN}`);
  const hub = path.join(base, 'hub');
  if (legacy) {
    write(path.join(hub, 'registry', 'projeler.json'), JSON.stringify({ projeler: [] }));
    write(path.join(hub, 'kutuphane', 'katalog.json'), JSON.stringify({ ogeler: [] }));
    write(path.join(hub, 'kutuphane', 'web', 'skills', 'alpha-skill', 'SKILL.md'), fm('alpha-skill'));
  } else initHub(hub);
  const lib = path.join(hub, 'library');
  write(path.join(lib, 'web', 'skills', 'alpha-skill', 'SKILL.md'), fm('alpha-skill', 'React components'));
  write(path.join(lib, 'web', 'skills', 'alpha-skill', 'scripts', 'run.txt'), 'echo alpha');
  write(path.join(lib, 'web', 'skills', 'alpha-skill', 'references', 'notes.md'), '# notes');
  write(path.join(lib, 'testing', 'skills', 'beta-skill', 'SKILL.md'), fm('beta-skill'));
  write(path.join(lib, 'design', 'agents', 'gamma-agent.md'), fm('gamma-agent'));
  const proj = (id, via) => {
    const dir = path.join(base, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    return { id, name: id.charAt(0).toUpperCase() + id.slice(1), kind: 'registered', path: dir, exists: true, via };
  };
  const projects = [proj('cc', ['claude-code']), proj('codex', ['codex']), proj('both', ['claude-code', 'gemini-cli']), proj('none', [])];
  projects.push({ id: 'broad', name: 'Broad', kind: 'adhoc', path: HOME, broad: true, via: [] });
  projects.push({ id: 'gone', name: 'Gone', kind: 'registered', path: path.join(base, 'projects', 'gone'), via: [] });
  projects.push({ id: 'unc', name: 'Unc', kind: 'registered', path: '\\\\server\\share\\x', via: [] });
  projects.push({ id: 'inhub', name: 'In hub', kind: 'registered', path: lib, via: [] });
  const catalog = { hubDir: hub, roster: new Map(), getProject: (id) => projects.find((p) => p.id === id) || null };
  const dir = (id) => projects.find((p) => p.id === id).path;
  return { base, hub, lib, projects, catalog, dir };
}

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

function fakeSpawn(calls, failCode = null) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => (failCode ? child.emit('error', Object.assign(new Error('fake'), { code: failCode })) : child.emit('spawn')));
    return child;
  };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${port}` };
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    for (const [k, v] of Object.entries(headers)) if (v === undefined) delete h[k];
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

const goodHeaders = (port, token) => ({ Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-SiberSentez-Token': token || '' });

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
  const actions = createActions({
    catalog: w.catalog,
    ingest: { sessions: new Map() },
    mode,
    port,
    hubDir: w.hub,
    workDir,
    homeDir: HOME,
    claudeDir: CLAUDE,
    spawn: fakeSpawn(spawnCalls),
    now: () => clock,
    log: (l) => logs.push(l),
    onChange: () => changes++,
    ...over,
  });
  server.on('request', createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port, publicDir: PUBLIC_DIR, actions }));
  return {
    port,
    actions,
    spawnCalls,
    logs,
    changes: () => changes,
    tick: (ms = 3000) => (clock += ms),
    post: (body, headers = {}) => request(port, { method: 'POST', path: '/api/action', body, headers: { ...goodHeaders(port, actions.token), ...headers } }),
    close: () => new Promise((r) => server.close(r)),
  };
}

const ALPHA = { kind: 'skill', name: 'alpha-skill' };
const BETA = { kind: 'skill', name: 'beta-skill' };
const GAMMA = { kind: 'agent', name: 'gamma-agent' };
const ops = (plan) => plan.map((e) => `${e.op}:${e.kind}:${e.name}${e.target ? '@' + e.target : ''}:${e.reason}`);

// ---------------- targets ----------------
test('default targets from via: claude for Claude Code or no .agents tool; agents for Codex, Gemini CLI, Antigravity', () => {
  assert.deepEqual(defaultTargets([]), ['claude'], 'none known');
  assert.deepEqual(defaultTargets(undefined), ['claude']);
  assert.deepEqual(defaultTargets(['claude-code']), ['claude']);
  assert.deepEqual(defaultTargets(['codex']), ['agents']);
  assert.deepEqual(defaultTargets(['gemini-cli']), ['agents']);
  assert.deepEqual(defaultTargets(['antigravity', 'copilot']), ['agents']);
  assert.deepEqual(defaultTargets(['claude-code', 'gemini-cli']), ['claude', 'agents']);
  assert.deepEqual(defaultTargets(['cursor']), ['claude'], 'Cursor reads .claude/skills');
  assert.deepEqual(defaultTargets(['copilot']), ['claude']);
  // Gemini CLI, Qwen Code, OpenCode and Codex: agent-only targets (server/agentFormats.mjs, 2026-10-07)
  assert.deepEqual([...TARGETS], ['claude', 'agents', 'gemini', 'qwen', 'opencode', 'codex']);
});

test('install: default targets from the project via; an agent always goes to .claude/agents only', async () => {
  const w = world();
  const env = await startServer(w, { mode: 'dry' });
  try {
    let r = await env.post({ action: 'skills-preview', projectId: 'codex', items: [ALPHA, GAMMA] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.targets, ['agents']);
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill@agents:new', 'copy:agent:gamma-agent@claude:new']);
    assert.equal(r.json.plan[0].path, path.join(w.dir('codex'), '.agents', 'skills', 'alpha-skill'));
    assert.equal(r.json.plan[1].path, path.join(w.dir('codex'), '.claude', 'agents', 'gamma-agent.md'));
    r = await env.post({ action: 'skills-preview', projectId: 'both', items: [ALPHA] });
    assert.deepEqual(r.json.targets, ['claude', 'agents']);
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill@claude:new', 'copy:skill:alpha-skill@agents:new']);
    r = await env.post({ action: 'skills-preview', projectId: 'none', items: [ALPHA] });
    assert.deepEqual(r.json.targets, ['claude']);
    // Explicit targets win; an agent with targets ['agents'] still goes to claude
    r = await env.post({ action: 'skills-preview', projectId: 'cc', items: [ALPHA, GAMMA], targets: ['agents'] });
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill@agents:new', 'copy:agent:gamma-agent@claude:new']);
  } finally {
    await env.close();
  }
});

// ---------------- install / record / hash ----------------
test('install live: the whole skill folder and the agent file are copied; the record is written with a SHA-256 tree hash; nothing else in the project', async () => {
  const w = world();
  const env = await startServer(w);
  try {
    const r = await env.post({ action: 'skills-install', projectId: 'both', items: [ALPHA, GAMMA] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.mode, 'live');
    assert.deepEqual(r.json.result, { executed: true, copied: 3, updated: 0 });
    const p = w.dir('both');
    for (const t of ['.claude', '.agents']) {
      const d = path.join(p, t, 'skills', 'alpha-skill');
      assert.equal(fs.readFileSync(path.join(d, 'scripts', 'run.txt'), 'utf8'), 'echo alpha', 'scripts/ copied too');
      assert.ok(exists(path.join(d, 'references', 'notes.md')), 'references/ copied too');
    }
    assert.equal(fs.readFileSync(path.join(p, '.claude', 'agents', 'gamma-agent.md'), 'utf8'), fm('gamma-agent'));
    assert.ok(!exists(path.join(p, '.agents', 'agents')), 'no agent under .agents');
    // Only the installed items are in the project: no manifest, no temp folder
    const all = snapshotTree(p).map((l) => l.split('|')[0]);
    assert.ok(!all.some((f) => /sibersentez|manifest|\.tmp/i.test(f)), all.join(','));
    const rec = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'installs.json'), 'utf8'));
    assert.equal(rec.version, 1);
    assert.equal(rec.installs.length, 3);
    const a = rec.installs.find((x) => x.kind === 'skill' && x.target === 'claude');
    assert.deepEqual(Object.keys(a).sort(), ['hash', 'installedAt', 'kind', 'name', 'path', 'project', 'source', 'target']);
    assert.equal(a.project, 'both');
    assert.equal(a.name, 'alpha-skill');
    assert.equal(a.path, path.join(p, '.claude', 'skills', 'alpha-skill'));
    assert.equal(a.source, 'library/web/skills/alpha-skill');
    assert.equal(a.installedAt, '2026-09-28T10:00:00.123Z');
    assert.equal(a.hash, treeHash(a.path));
    assert.equal(a.hash, treeHash(path.join(w.lib, 'web', 'skills', 'alpha-skill')), 'same tree, same hash');
    assert.deepEqual(fs.readdirSync(path.join(w.hub, 'registry')).sort(), ['installs.json', 'projects.json'], 'written atomically: no temp file left');
    assert.equal(env.changes(), 1, 'the catalog reload hook ran once');
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('hash: SHA-256 over relative paths and contents, independent of the folder name; an agent hashes its contents only', () => {
  const a = path.join(ROOT, 'hash-a', 'x');
  write(path.join(a, 'SKILL.md'), 'one');
  write(path.join(a, 'sub', 'f.txt'), 'two');
  const expected = crypto.createHash('sha256');
  expected.update('dir\n');
  expected.update('F SKILL.md 3\n');
  expected.update('one');
  expected.update('D sub\n');
  expected.update('F sub/f.txt 3\n');
  expected.update('two');
  assert.equal(treeHash(a), expected.digest('hex'));
  const b = path.join(ROOT, 'hash-b', 'other-name');
  fs.cpSync(a, b, { recursive: true });
  assert.equal(treeHash(b), treeHash(a), 'the folder name is not part of the hash');
  write(path.join(b, 'sub', 'f.txt'), 'TWO');
  assert.notEqual(treeHash(b), treeHash(a), 'content counts');
  fs.cpSync(a, path.join(ROOT, 'hash-c'), { recursive: true });
  fs.renameSync(path.join(ROOT, 'hash-c', 'sub'), path.join(ROOT, 'hash-c', 'sub2'));
  assert.notEqual(treeHash(path.join(ROOT, 'hash-c')), treeHash(a), 'relative paths count');
  write(path.join(ROOT, 'hash-f1', 'one.md'), 'agent');
  write(path.join(ROOT, 'hash-f2', 'two.md'), 'agent');
  assert.equal(treeHash(path.join(ROOT, 'hash-f1', 'one.md')), treeHash(path.join(ROOT, 'hash-f2', 'two.md')));
  assert.equal(treeHash(path.join(ROOT, 'missing-tree')), null);
  // A link inside counts in 'mark' mode (an installed tree), not in 'skip' mode (what a copy produces)
  const l = path.join(ROOT, 'hash-l');
  fs.cpSync(a, l, { recursive: true });
  junction(path.join(ROOT, 'hash-b'), path.join(l, 'jn'));
  assert.notEqual(treeHash(l), treeHash(a));
  assert.equal(treeHash(l, { links: 'skip' }), treeHash(a));
});

test('install skip reasons: project-owned, modified, up-to-date, not-in-library; library changed -> update', async () => {
  const w = world();
  const env = await startServer(w);
  const p = w.dir('cc');
  try {
    // Project-owned: same name, not installed by SiberSentez (even with identical content)
    write(path.join(p, '.claude', 'skills', 'beta-skill', 'SKILL.md'), fm('beta-skill'));
    let r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA, BETA, GAMMA, { kind: 'skill', name: 'no-such-skill' }] });
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill@claude:new', 'skip:skill:beta-skill@claude:project-owned', 'copy:agent:gamma-agent@claude:new', 'skip:skill:no-such-skill@claude:not-in-library']);
    assert.equal(fs.readFileSync(path.join(p, '.claude', 'skills', 'beta-skill', 'SKILL.md'), 'utf8'), fm('beta-skill'), 'untouched');
    env.tick();
    // Same content again: up-to-date, nothing written
    const before = snapshotTree(p);
    r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA, GAMMA] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@claude:up-to-date', 'skip:agent:gamma-agent@claude:up-to-date']);
    assert.deepEqual(snapshotTree(p), before);
    env.tick();
    // Modified in the project: skipped, the user's change stays
    write(path.join(p, '.claude', 'skills', 'alpha-skill', 'mine.txt'), 'my note');
    write(path.join(p, '.claude', 'agents', 'gamma-agent.md'), 'edited by hand');
    r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA, GAMMA] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@claude:modified', 'skip:agent:gamma-agent@claude:modified']);
    assert.equal(fs.readFileSync(path.join(p, '.claude', 'agents', 'gamma-agent.md'), 'utf8'), 'edited by hand');
    assert.ok(exists(path.join(p, '.claude', 'skills', 'alpha-skill', 'mine.txt')));
    env.tick();
    // Library changed since the install (and the project copy unchanged): update, record hash follows
    fs.rmSync(path.join(p, '.claude', 'skills', 'alpha-skill', 'mine.txt'));
    write(path.join(w.lib, 'web', 'skills', 'alpha-skill', 'scripts', 'run.txt'), 'echo alpha v2');
    r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.deepEqual(ops(r.json.plan), ['update:skill:alpha-skill@claude:library-changed']);
    assert.deepEqual(r.json.result, { executed: true, copied: 0, updated: 1 });
    assert.equal(fs.readFileSync(path.join(p, '.claude', 'skills', 'alpha-skill', 'scripts', 'run.txt'), 'utf8'), 'echo alpha v2');
    const rec = readInstalls(w.hub).installs.find((x) => x.name === 'alpha-skill');
    assert.equal(rec.hash, treeHash(path.join(p, '.claude', 'skills', 'alpha-skill')));
    assert.ok(!fs.readdirSync(path.join(p, '.claude', 'skills')).some((n) => n.startsWith('.sibersentez-')), 'no staging folder left');
    env.tick();
    // Recorded but deleted by hand: copied again (reason missing)
    fs.rmSync(path.join(p, '.claude', 'skills', 'alpha-skill'), { recursive: true });
    r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill@claude:missing']);
  } finally {
    await env.close();
  }
});

test('install skip reasons: a library item over the size or file limit is never copied (too-large, too-many-files), in the plan and in the trial', async () => {
  const w = world();
  for (let i = 0; i < 501; i++) write(path.join(w.lib, 'web', 'skills', 'many-files', 'f', `${i}.txt`), 'x');
  write(path.join(w.lib, 'web', 'skills', 'many-files', 'SKILL.md'), fm('many-files'));
  write(path.join(w.lib, 'web', 'skills', 'huge-skill', 'SKILL.md'), fm('huge-skill'));
  fs.writeFileSync(path.join(w.lib, 'web', 'skills', 'huge-skill', 'blob.bin'), Buffer.alloc(20 * 1024 * 1024 + 1));
  const env = await startServer(w);
  try {
    const items = [{ kind: 'skill', name: 'many-files' }, { kind: 'skill', name: 'huge-skill' }, ALPHA];
    const r = await env.post({ action: 'skills-install', projectId: 'cc', items });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:many-files@claude:too-many-files', 'skip:skill:huge-skill@claude:too-large', 'copy:skill:alpha-skill@claude:new']);
    assert.deepEqual(fs.readdirSync(path.join(w.dir('cc'), '.claude', 'skills')), ['alpha-skill']);
    const t = await env.post({ action: 'skills-trial', projectId: 'cc', items: items.slice(0, 2) });
    assert.equal(t.status, 409);
    assert.equal(t.json.error, 'nothing-to-try');
    assert.deepEqual(ops(t.json.plan), ['skip:skill:many-files:too-many-files', 'skip:skill:huge-skill:too-large']);
  } finally {
    await env.close();
  }
});

test('record: written atomically; a broken record is never overwritten (record-broken) and preview refuses too', async () => {
  const w = world();
  const file = path.join(w.hub, 'registry', 'installs.json');
  write(file, '{broken');
  const env = await startServer(w);
  try {
    for (const action of ['skills-install', 'skills-preview', 'skills-remove']) {
      const r = await env.post({ action, projectId: 'cc', items: [ALPHA] });
      assert.equal(r.status, 409, action);
      assert.equal(r.json.error, 'record-broken');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
    assert.ok(!exists(path.join(w.dir('cc'), '.claude')), 'nothing installed');
  } finally {
    await env.close();
  }
  // Rows missing a field are ignored when reading; the file keeps its shape
  write(file, JSON.stringify({ version: 1, installs: [{ project: 'cc' }, null, { project: 'cc', target: 'claude', kind: 'skill', name: 'x', path: 'C:\\x', hash: 'h' }] }));
  assert.equal(readInstalls(w.hub).installs.length, 1);
  assert.equal(readInstalls(null).ok, true);
});

// ---------------- remove ----------------
test('remove: only what the record lists and only when unchanged; plan: true and dry write nothing', async () => {
  const w = world();
  const env = await startServer(w);
  const p = w.dir('both');
  try {
    let r = await env.post({ action: 'skills-install', projectId: 'both', items: [ALPHA, BETA, GAMMA] });
    assert.equal(r.json.result.copied, 5);
    env.tick();
    // A project-owned item with a recorded name elsewhere and an item never installed
    write(path.join(p, '.claude', 'skills', 'own-skill', 'SKILL.md'), fm('own-skill'));
    write(path.join(p, '.agents', 'skills', 'beta-skill', 'extra.txt'), 'user change');
    const before = snapshotTree(p);
    r = await env.post({ action: 'skills-remove', projectId: 'both', items: [ALPHA, BETA, GAMMA, { kind: 'skill', name: 'own-skill' }, { kind: 'skill', name: 'never' }], plan: true });
    assert.equal(r.status, 200);
    assert.deepEqual(ops(r.json.plan), [
      'remove:skill:alpha-skill@claude:unchanged',
      'remove:skill:alpha-skill@agents:unchanged',
      'remove:skill:beta-skill@claude:unchanged',
      'skip:skill:beta-skill@agents:modified',
      'remove:agent:gamma-agent@claude:unchanged',
      'skip:skill:own-skill@claude:project-owned',
      'skip:skill:own-skill@agents:not-installed',
      'skip:skill:never@claude:not-installed',
      'skip:skill:never@agents:not-installed',
    ]);
    assert.equal(r.json.result.executed, false);
    assert.deepEqual(snapshotTree(p), before, 'plan: true writes nothing');
    env.tick();
    r = await env.post({ action: 'skills-remove', projectId: 'both', items: [ALPHA, BETA, GAMMA, { kind: 'skill', name: 'own-skill' }] });
    assert.deepEqual(r.json.result, { executed: true, removed: 4, forgotten: 0 });
    assert.ok(!exists(path.join(p, '.claude', 'skills', 'alpha-skill')));
    assert.ok(!exists(path.join(p, '.agents', 'skills', 'alpha-skill')));
    assert.ok(!exists(path.join(p, '.claude', 'agents', 'gamma-agent.md')));
    assert.ok(exists(path.join(p, '.agents', 'skills', 'beta-skill', 'extra.txt')), 'modified item stays');
    assert.ok(exists(path.join(p, '.claude', 'skills', 'own-skill', 'SKILL.md')), 'project-owned item stays');
    const rec = readInstalls(w.hub).installs;
    assert.deepEqual(rec.map((x) => `${x.name}@${x.target}`), ['beta-skill@agents'], 'only the kept item is still recorded');
    assert.equal(env.changes(), 2);
    env.tick();
    // A recorded item deleted by hand: only its record entry goes
    fs.rmSync(path.join(p, '.agents', 'skills', 'beta-skill'), { recursive: true });
    r = await env.post({ action: 'skills-remove', projectId: 'both', items: [BETA], targets: ['agents'] });
    assert.deepEqual(ops(r.json.plan), ['remove:skill:beta-skill@agents:missing']);
    assert.deepEqual(r.json.result, { executed: true, removed: 0, forgotten: 1 });
    assert.equal(readInstalls(w.hub).installs.length, 0);
  } finally {
    await env.close();
  }
});

test('remove: a record that points at another folder (the project moved) never deletes the new folder', () => {
  const w = world();
  const p = w.dir('cc');
  write(path.join(p, '.claude', 'skills', 'alpha-skill', 'SKILL.md'), fm('alpha-skill'));
  const dest = path.join(p, '.claude', 'skills', 'alpha-skill');
  const installs = [{ project: 'cc', target: 'claude', kind: 'skill', name: 'alpha-skill', path: path.join(ROOT, 'old-place', 'alpha-skill'), hash: treeHash(dest) }];
  const plan = planRemove({ project: { id: 'cc' }, dir: p, items: [ALPHA], targets: ['claude'], installs });
  assert.deepEqual(ops(plan), ['skip:skill:alpha-skill@claude:project-owned']);
  const iplan = planInstall({ project: { id: 'cc' }, dir: p, items: [ALPHA], targets: ['claude'], library: listLibrary(w.hub), installs });
  assert.deepEqual(ops(iplan), ['skip:skill:alpha-skill@claude:project-owned']);
});

// ---------------- destinations and reparse points ----------------
test('destinations stay inside <p>/.claude or <p>/.agents (resolved): a name that would climb out is skipped, nothing is written outside', () => {
  const w = world();
  const p = w.dir('cc');
  const src = path.join(w.lib, 'web', 'skills', 'alpha-skill');
  const library = [
    { kind: 'skill', name: '../escape', path: src, rel: 'x' },
    { kind: 'agent', name: '..\\..\\escape-agent', path: path.join(w.lib, 'design', 'agents', 'gamma-agent.md'), rel: 'y' },
    { kind: 'skill', name: 'sub/inner', path: src, rel: 'z' },
  ];
  const items = library.map(({ kind, name }) => ({ kind, name }));
  const plan = planInstall({ project: { id: 'cc' }, dir: p, items, targets: ['claude', 'agents'], library, installs: [] });
  assert.deepEqual(plan.map((e) => `${e.op}:${e.reason}`), Array(plan.length).fill('skip:outside-project'));
  executeInstall({ plan, project: { id: 'cc' }, hubDir: w.hub, installs: [] });
  assert.ok(!exists(path.join(p, '.claude')) && !exists(path.join(p, '.agents')), 'nothing written');
  assert.ok(!exists(path.join(p, 'escape-agent.md')) && !exists(path.join(path.dirname(p), 'escape-agent.md')));
  // The same rule for every real destination
  for (const t of ['claude', 'agents']) {
    const d = destination(p, 'skill', 'ok-name', t);
    assert.equal(d.inside, true);
    assert.equal(path.dirname(d.dest), path.join(p, t === 'claude' ? '.claude' : '.agents', 'skills'));
  }
  assert.equal(destination(p, 'agent', 'a', 'claude').dest, path.join(p, '.claude', 'agents', 'a.md'));
});

test('reparse points: a junction as .claude, as .claude/skills or as the destination itself is refused; the junction target is never written or deleted', async () => {
  const w = world();
  const env = await startServer(w);
  try {
    const outside = path.join(w.base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    write(path.join(outside, 'keep.txt'), 'keep');
    // .claude is a junction
    junction(outside, path.join(w.dir('cc'), '.claude'));
    let r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA, GAMMA] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@claude:reparse-point', 'skip:agent:gamma-agent@claude:reparse-point']);
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
    // .agents/skills is a junction (the parent of the destination)
    junction(outside, path.join(w.dir('codex'), '.agents', 'skills'));
    r = await env.post({ action: 'skills-install', projectId: 'codex', items: [ALPHA] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@agents:reparse-point']);
    // The destination itself is a junction
    junction(outside, path.join(w.dir('none'), '.claude', 'skills', 'alpha-skill'));
    r = await env.post({ action: 'skills-install', projectId: 'none', items: [ALPHA] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@claude:reparse-point']);
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt'], 'the target was never written');
    env.tick();
    // Installed, then .claude/skills replaced by a junction: remove refuses, nothing behind it is deleted
    r = await env.post({ action: 'skills-install', projectId: 'both', items: [ALPHA], targets: ['claude'] });
    assert.equal(r.json.result.copied, 1);
    const skills = path.join(w.dir('both'), '.claude', 'skills');
    fs.renameSync(skills, path.join(w.base, 'moved-skills'));
    fs.cpSync(path.join(w.base, 'moved-skills'), path.join(outside, 'copy'), { recursive: true });
    junction(path.join(outside, 'copy'), skills);
    r = await env.post({ action: 'skills-remove', projectId: 'both', items: [ALPHA], targets: ['claude'] });
    assert.deepEqual(ops(r.json.plan), ['skip:skill:alpha-skill@claude:reparse-point']);
    assert.ok(exists(path.join(outside, 'copy', 'alpha-skill', 'SKILL.md')));
  } finally {
    await env.close();
  }
});

test('copies never follow links: a junction inside a library skill is skipped (the target is not copied)', async () => {
  const w = world();
  const secret = path.join(w.base, 'secret');
  write(path.join(secret, 'private.txt'), 'private');
  junction(secret, path.join(w.lib, 'web', 'skills', 'alpha-skill', 'linked'));
  const env = await startServer(w);
  try {
    const r = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.equal(r.json.result.copied, 1);
    const d = path.join(w.dir('cc'), '.claude', 'skills', 'alpha-skill');
    assert.ok(exists(path.join(d, 'SKILL.md')));
    assert.ok(!exists(path.join(d, 'linked')), 'the link is not copied');
    // The installed copy (no link) is up to date with the library (links are not part of a copy)
    env.tick();
    const again = await env.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.deepEqual(ops(again.json.plan), ['skip:skill:alpha-skill@claude:up-to-date']);
  } finally {
    await env.close();
  }
});

// ---------------- projects ----------------
test('project rules: unknown, broad, missing, not local, inside the hub, the personal Claude folder -> refused before anything is read', async () => {
  const w = world();
  const env = await startServer(w);
  try {
    const cases = [
      ['no-such', 404, 'not-a-project'],
      ['broad', 409, 'broad-folder'],
      ['gone', 404, 'folder-missing'],
      ['unc', 409, 'not-local'],
      ['inhub', 409, 'project-in-hub'],
    ];
    for (const [projectId, status, error] of cases) {
      const r = await env.post({ action: 'skills-install', projectId, items: [ALPHA] });
      assert.equal(r.status, status, projectId);
      assert.equal(r.json.error, error, projectId);
    }
    // A registered project whose path is the home folder or a drive root is broad too
    w.projects.push({ id: 'home-reg', name: 'Home', kind: 'registered', path: HOME, via: [] });
    assert.equal((await env.post({ action: 'skills-preview', projectId: 'home-reg', items: [ALPHA] })).json.error, 'broad-folder');
    assert.equal(resolveProject({ catalog: { getProject: () => ({ id: 'r', path: 'C:\\' }) }, projectId: 'r' }).error, 'broad-folder');
  } finally {
    await env.close();
  }
  // CLAUDE_CONFIG_DIR pointing into a project: its .claude is the personal folder
  const personalHome = path.join(w.base, 'phome');
  const proj = path.join(w.base, 'projects', 'holder');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  w.projects.push({ id: 'holder', name: 'Holder', kind: 'registered', path: proj, via: [] });
  const env2 = await startServer(w, { homeDir: personalHome, claudeDir: path.join(proj, '.claude') });
  try {
    const r = await env2.post({ action: 'skills-install', projectId: 'holder', items: [ALPHA] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'personal-folder');
    assert.deepEqual(fs.readdirSync(path.join(proj, '.claude')), []);
  } finally {
    await env2.close();
  }
});

test('catalog counts change at once: after a live install and remove the reload hook refreshes the project counts', async () => {
  const base = path.join(ROOT, 'counts');
  const home = path.join(base, 'home');
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const hub = path.join(base, 'hub');
  initHub(hub);
  const proj = path.join(base, 'work', 'counted');
  fs.mkdirSync(proj, { recursive: true });
  write(path.join(hub, 'registry', 'projects.json'), JSON.stringify({ projects: [{ id: 'counted', name: 'Counted', path: proj }] }));
  write(path.join(hub, 'library', 'web', 'skills', 'alpha-skill', 'SKILL.md'), fm('alpha-skill'));
  write(path.join(hub, 'library', 'design', 'agents', 'gamma-agent.md'), fm('gamma-agent'));
  const catalog = new Catalog({ env: {}, hubDir: hub, claudeDir: claude, homeDir: home });
  catalog.load();
  assert.deepEqual(catalog.getProject('counted').installed, { skills: 0, agents: 0 });
  assert.equal(catalog.hub.library, 2, 'library items come from the folders');
  const w = { base, hub, catalog };
  const env = await startServer(w, { homeDir: home, claudeDir: claude, onChange: () => catalog.load() });
  try {
    const r = await env.post({ action: 'skills-install', projectId: 'counted', items: [ALPHA, GAMMA] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(catalog.getProject('counted').installed, { skills: 1, agents: 1 }, 'counts changed without waiting for the minute reload');
    assert.deepEqual(catalog.roster.get('skill:alpha-skill').installedIn, ['counted']);
    env.tick();
    await env.post({ action: 'skills-remove', projectId: 'counted', items: [ALPHA, GAMMA] });
    assert.deepEqual(catalog.getProject('counted').installed, { skills: 0, agents: 0 });
  } finally {
    await env.close();
  }
});

// ---------------- trial ----------------
test('trial: session-only plugin folder with skills/<name>/, agents/<name>.md and the marker; argv starts Claude Code with --plugin-dir <that folder>', async () => {
  const w = world();
  const env = await startServer(w);
  try {
    const r = await env.post({ action: 'skills-trial', projectId: 'both', items: [ALPHA, GAMMA, { kind: 'skill', name: 'missing-one' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const dir = r.json.result.trialDir;
    assert.equal(path.dirname(dir), path.join(w.hub, 'trials'));
    assert.equal(path.basename(dir), '20260928-100000-123-both');
    assert.equal(trialName('Both Project!', Date.UTC(2026, 0, 2, 3, 4, 5, 6)), '20260102-030405-006-both-project');
    assert.deepEqual(ops(r.json.plan), ['copy:skill:alpha-skill:trial', 'copy:agent:gamma-agent:trial', 'skip:skill:missing-one:not-in-library', 'skip:tool:gemini-cli:trial-claude-code-only']);
    assert.ok(exists(path.join(dir, 'skills', 'alpha-skill', 'scripts', 'run.txt')));
    assert.ok(exists(path.join(dir, 'agents', 'gamma-agent.md')));
    assert.deepEqual(fs.readdirSync(dir).sort(), [TRIAL_MARKER, 'agents', 'skills']);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, TRIAL_MARKER), 'utf8'));
    assert.deepEqual(marker, { sibersentez: 'trial', version: 1, createdAt: '2026-09-28T10:00:00.123Z', project: 'both', items: [ALPHA, GAMMA] });
    assert.deepEqual(r.json.argv, ['wt.exe', '-w', 'sibersentez', 'new-tab', '-d', w.dir('both'), '--title', 'Both', '--suppressApplicationTitle', 'claude', '-n', 'both', '--session-id', r.json.sessionId, '--plugin-dir', dir]);
    assert.equal(env.spawnCalls.length, 1);
    const c = env.spawnCalls[0];
    assert.deepEqual([c.cmd, ...c.args], r.json.argv);
    assert.equal(c.opts.shell, false);
    assert.ok(!exists(path.join(w.dir('both'), '.claude')), 'nothing is written into the project');
    assert.equal(env.changes(), 0);
  } finally {
    await env.close();
  }
});

test('trial: dry shows the argv and the folder layout, writes and starts nothing; nothing to copy -> 409; terminal missing -> the folder is removed', async () => {
  const w = world();
  const before = snapshotTree(w.base);
  const env = await startServer(w, { mode: 'dry' });
  try {
    const r = await env.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, 'dry');
    assert.equal(r.json.result.executed, false);
    assert.deepEqual(r.json.argv.slice(-2), ['--plugin-dir', r.json.result.trialDir]);
    assert.equal(r.json.plan[0].path, path.join(r.json.result.trialDir, 'skills', 'alpha-skill'));
    assert.equal(env.spawnCalls.length, 0);
    const none = await env.post({ action: 'skills-trial', projectId: 'cc', items: [{ kind: 'skill', name: 'nope' }] });
    assert.equal(none.status, 409);
    assert.equal(none.json.error, 'nothing-to-try');
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before, 'dry wrote nothing');
  const calls = [];
  const env2 = await startServer(w, { spawn: fakeSpawn(calls, 'ENOENT') });
  try {
    const r = await env2.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
    assert.equal(r.status, 501);
    assert.equal(r.json.error, 'terminal-missing');
    assert.deepEqual(fs.readdirSync(path.join(w.hub, 'trials')), [], 'the new trial folder was removed');
  } finally {
    await env2.close();
  }
  // A ';' in the hub path would reach Windows Terminal: refused before anything is written
  const semi = world();
  const semiHub = path.join(semi.base, 'hub;x');
  fs.renameSync(semi.hub, semiHub);
  const env3 = await startServer({ ...semi, hub: semiHub, catalog: { ...semi.catalog, hubDir: semiHub } }, { hubDir: semiHub });
  try {
    const r = await env3.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'unsafe-path');
    assert.ok(!exists(path.join(semiHub, 'trials')));
    assert.equal(env3.spawnCalls.length, 0);
  } finally {
    await env3.close();
  }
});

test('trial cleanup: only real trial folders with the marker and older than 7 days; nothing else in trials/ is touched; a junction inside is not followed', () => {
  const w = world();
  const trials = path.join(w.hub, 'trials');
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);
  const DAY = 86400000;
  const make = (name, { createdAt = new Date(now - 8 * DAY).toISOString(), marker = true, extra } = {}) => {
    const d = path.join(trials, name);
    fs.mkdirSync(path.join(d, 'skills', 'x'), { recursive: true });
    write(path.join(d, 'skills', 'x', 'SKILL.md'), fm('x'));
    if (marker) write(path.join(d, TRIAL_MARKER), JSON.stringify({ sibersentez: 'trial', version: 1, createdAt, project: 'cc', items: [] }));
    if (extra) extra(d);
    return d;
  };
  const outside = path.join(w.base, 'precious');
  write(path.join(outside, 'data.txt'), 'data');
  const old = make('20260910-100000-000-cc', { extra: (d) => junction(outside, path.join(d, 'jn')) });
  const recent = make('20260925-100000-000-cc', { createdAt: new Date(now - 6 * DAY).toISOString() });
  const exactly7 = make('20260921-120000-000-cc', { createdAt: new Date(now - 7 * DAY).toISOString() });
  const unmarked = make('20260901-100000-000-cc', { marker: false });
  const wrongName = make('my-own-folder');
  const badMarker = make('20260902-100000-000-cc', { marker: false, extra: (d) => write(path.join(d, TRIAL_MARKER), '{"sibersentez":"other","version":1,"createdAt":"2020-01-01T00:00:00Z"}') });
  const badDate = make('20260903-100000-000-cc', { createdAt: 'yesterday' });
  write(path.join(trials, 'notes.txt'), 'user file');
  const linkedTrial = path.join(trials, '20260904-100000-000-linked');
  const linkTarget = make('20260905-100000-000-target', { createdAt: new Date(now).toISOString() });
  junction(linkTarget, linkedTrial);
  const r = cleanupTrials(w.hub, { now });
  assert.deepEqual(r, { removed: 1, kept: 9 });
  assert.ok(!exists(old), 'the old marked trial folder is gone');
  for (const d of [recent, exactly7, unmarked, wrongName, badMarker, badDate, linkTarget]) assert.ok(exists(d), d);
  assert.ok(exists(path.join(trials, 'notes.txt')));
  assert.ok(fs.lstatSync(linkedTrial).isSymbolicLink(), 'a link in trials/ is left alone');
  assert.equal(fs.readFileSync(path.join(outside, 'data.txt'), 'utf8'), 'data', 'the junction inside the removed folder was not followed');
  // No hub, no trials folder, a legacy hub: nothing happens
  assert.deepEqual(cleanupTrials(null), { removed: 0, kept: 0 });
  assert.deepEqual(cleanupTrials(path.join(ROOT, 'no-hub-here')), { removed: 0, kept: 0 });
  const lw = world({ legacy: true });
  const legacyTrial = path.join(lw.hub, 'trials', '20200101-000000-000-x');
  write(path.join(legacyTrial, TRIAL_MARKER), JSON.stringify({ sibersentez: 'trial', version: 1, createdAt: '2020-01-01T00:00:00Z' }));
  assert.deepEqual(cleanupTrials(lw.hub, { now }), { removed: 0, kept: 0 });
  assert.ok(exists(legacyTrial), 'a legacy hub is never written');
});

// ---------------- action surface ----------------
test('actions: the skill actions (skills-apply from docs/auto-skills.md, then the restore points of docs/restore.md) are listed with the launch actions; off -> 404 for every one, no file written', async () => {
  assert.deepEqual([...SKILL_ACTIONS], ['library-scan', 'library-import', 'library-adopt', 'skills-preview', 'skills-install', 'skills-remove', 'skills-trial', 'skills-apply', 'restore-preview', 'restore-apply']);
  // start-ai (docs/ai-start.md) follows the skill actions; the GitHub import's actions come last (docs/github-import.md)
  assert.deepEqual([...ACTION_NAMES], [...LAUNCH_ACTIONS, ...SKILL_ACTIONS, 'start-ai', 'github-fetch', 'github-import', 'github-discard', 'github-check-update']);
  const w = world();
  const on = await startServer(w, { mode: 'dry' });
  try {
    const g = await request(on.port, { path: '/api/actions', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.deepEqual(g.json.actions, [...ACTION_NAMES]);
  } finally {
    await on.close();
  }
  const before = snapshotTree(w.base);
  const env = await startServer(w, { mode: 'off' });
  try {
    const bodies = [
      { action: 'library-scan', source: w.base },
      { action: 'library-import', source: w.base, items: [{ path: 'x', category: 'web' }] },
      { action: 'skills-preview', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-install', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-remove', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-trial', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-apply', projectId: 'cc' },
    ];
    for (const b of bodies) {
      const r = await env.post(b, { 'X-SiberSentez-Token': 'a'.repeat(64) });
      assert.equal(r.status, 404, b.action);
      assert.equal(r.json.error, 'actions-off');
    }
    assert.equal(env.logs.length, 0);
    assert.equal(env.spawnCalls.length, 0);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')));
});

test('actions: dry mode writes nothing and starts nothing for every skill action; the reply carries the plan', async () => {
  const w = world();
  const src = path.join(w.base, 'import-src');
  write(path.join(src, 'skills', 'new-skill', 'SKILL.md'), fm('new-skill'));
  // Something to remove in dry mode: installed earlier in live mode
  const live = await startServer(w);
  await live.post({ action: 'skills-install', projectId: 'cc', items: [BETA] });
  await live.close();
  const before = snapshotTree(w.base);
  const env = await startServer(w, { mode: 'dry' });
  try {
    const bodies = [
      { action: 'library-scan', source: src },
      { action: 'library-import', source: src, items: [{ path: 'skills/new-skill', category: 'web' }] },
      { action: 'skills-preview', projectId: 'cc', items: [ALPHA, GAMMA] },
      { action: 'skills-install', projectId: 'cc', items: [ALPHA, GAMMA] },
      { action: 'skills-remove', projectId: 'cc', items: [BETA] },
      { action: 'skills-trial', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-apply', projectId: 'cc', keys: ['agent:gamma-agent'] },
    ];
    for (const b of bodies) {
      const r = await env.post(b);
      assert.equal(r.status, 200, `${b.action} ${JSON.stringify(r.json)}`);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.mode, 'dry');
      assert.equal(r.json.action, b.action);
      assert.ok(Array.isArray(r.json.plan), b.action);
      if (b.action !== 'library-scan') assert.ok(r.json.plan.length > 0 && r.json.plan.every((e) => e.op && e.kind && e.name && e.reason), b.action);
      // skills-apply also says in plain terms that nothing was copied (docs/auto-skills.md §3)
      if (b.action === 'skills-apply') assert.deepEqual([r.json.applied, r.json.reason], [false, 'preview-mode']);
    }
    assert.equal(env.spawnCalls.length, 0);
    assert.equal(env.changes(), 0);
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.base).filter((l) => !l.startsWith('app')), before.filter((l) => !l.startsWith('app')), 'dry wrote nothing');
});

test('actions: legacy hub -> every skill action refused with legacy-hub; the legacy hub is not written', async () => {
  const w = world({ legacy: true });
  const src = path.join(w.base, 'import-src');
  write(path.join(src, 'skills', 'new-skill', 'SKILL.md'), fm('new-skill'));
  const before = snapshotTree(w.hub);
  const env = await startServer(w);
  try {
    for (const b of [
      { action: 'library-scan', source: src },
      { action: 'library-import', source: src, items: [{ path: 'skills/new-skill', category: 'web' }] },
      { action: 'skills-preview', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-install', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-remove', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-trial', projectId: 'cc', items: [ALPHA] },
      { action: 'skills-apply', projectId: 'cc' },
    ]) {
      const r = await env.post(b);
      assert.equal(r.status, 409, b.action);
      assert.equal(r.json.error, 'legacy-hub', b.action);
    }
  } finally {
    await env.close();
  }
  assert.deepEqual(snapshotTree(w.hub), before);
  assert.ok(!exists(path.join(w.dir('cc'), '.claude')));
  // No hub at all: 404 no-hub
  const env2 = await startServer(w, { hubDir: null });
  try {
    const r = await env2.post({ action: 'skills-preview', projectId: 'cc', items: [ALPHA] });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'no-hub');
  } finally {
    await env2.close();
  }
});

test('actions: token, Origin and Sec-Fetch-Site are checked before any skill action is validated (403), as for the launch actions', async () => {
  const w = world();
  const env = await startServer(w);
  const body = { action: 'skills-install', projectId: 'cc', items: [ALPHA] };
  try {
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': 'b'.repeat(64) })).status, 403);
    assert.equal((await env.post(body, { 'X-SiberSentez-Token': undefined })).status, 403);
    assert.equal((await env.post(body, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await env.post(body, { Origin: undefined })).status, 403);
    assert.equal((await env.post(body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await env.post(body, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await request(env.port, { method: 'POST', path: '/api/action', body, headers: { ...goodHeaders(env.port, env.actions.token), Host: `evil.example:${env.port}` } })).status, 421);
    assert.ok(!exists(path.join(w.dir('cc'), '.claude')), 'nothing installed by a rejected request');
    assert.equal((await env.post(body)).status, 200, 'the same request with the right headers passes');
    // Log lines keep the fixed format and carry no path
    for (const l of env.logs) {
      assert.match(l, /^\[action\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+ \S+ \d{3} \S+$/);
      assert.ok(!l.includes(w.base), l);
    }
    assert.match(env.logs.at(-1), / skills-install cc 200 live$/);
  } finally {
    await env.close();
  }
});

test('actions: body validation codes (400) come before the hub and project checks; the name pattern is enforced', async () => {
  const w = world();
  const env = await startServer(w);
  try {
    const cases = [
      [{ action: 'skills-install', projectId: 'cc' }, 'missing-field'],
      [{ action: 'skills-install', projectId: 'cc', items: [ALPHA], path: 'C:\\x' }, 'unexpected-field'],
      [{ action: 'skills-install', projectId: 'cc', items: [ALPHA], packages: ['web'] }, 'unexpected-field'],
      [{ action: 'skills-install', projectId: 'cc', items: [] }, 'bad-items'],
      [{ action: 'skills-install', projectId: 'cc', items: 'alpha-skill' }, 'bad-items'],
      [{ action: 'skills-install', projectId: 'cc', items: [{ kind: 'skill', name: 'a', path: 'x' }] }, 'bad-items'],
      [{ action: 'skills-install', projectId: 'cc', items: [{ kind: 'plugin', name: 'a' }] }, 'bad-kind'],
      [{ action: 'skills-install', projectId: 'cc', items: Array.from({ length: MAX_SKILL_ITEMS + 1 }, (_, i) => ({ kind: 'skill', name: `s${i}` })) }, 'too-many-items'],
      [{ action: 'skills-install', projectId: 'cc', items: [ALPHA], targets: ['global'] }, 'bad-targets'],
      [{ action: 'skills-install', projectId: 'cc', items: [ALPHA], targets: [] }, 'bad-targets'],
      [{ action: 'skills-remove', projectId: 'cc', items: [ALPHA], plan: 'yes' }, 'bad-field'],
      [{ action: 'skills-install', projectId: '-cc', items: [ALPHA] }, 'bad-project-id'],
      [{ action: 'library-scan', source: 42 }, 'bad-source'],
      [{ action: 'library-import', source: w.base, items: [{ path: 'x', category: 'Web Stuff' }] }, 'bad-category'],
      [{ action: 'library-import', source: w.base, items: [{ path: 'x', category: 'web', extra: 1 }] }, 'bad-items'],
    ];
    for (const name of ['../x', '..', 'a/b', 'a\\b', 'Bad Name', '-dash', 'trailing.', 'con', 'NUL.md', 'x'.repeat(65), '', 'ş']) cases.push([{ action: 'skills-install', projectId: 'cc', items: [{ kind: 'skill', name }] }, 'bad-name']);
    for (const [b, error] of cases) {
      const r = await env.post(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.error, error, JSON.stringify(b));
    }
    // Valid names pass the pattern (the plan then says whether the library has them)
    for (const name of ['a', 'A1', 'my.skill', 'my_skill-2', 'x'.repeat(64)]) {
      env.tick();
      const r = await env.post({ action: 'skills-preview', projectId: 'cc', items: [{ kind: 'skill', name }] });
      assert.equal(r.status, 200, name);
      assert.equal(r.json.plan[0].reason, 'not-in-library');
    }
    assert.ok(!exists(path.join(w.dir('cc'), '.claude')));
  } finally {
    await env.close();
  }
});

test('actions: the same request twice within 3 s -> 429; another selection passes; one writing action at a time', async () => {
  const w = world();
  const env = await startServer(w, { mode: 'dry' });
  try {
    const b = { action: 'skills-preview', projectId: 'cc', items: [ALPHA] };
    assert.equal((await env.post(b)).status, 200);
    assert.equal((await env.post(b)).status, 429);
    assert.equal((await env.post({ ...b, items: [BETA] })).status, 200, 'another selection is not a repeat');
    assert.equal((await env.post({ ...b, action: 'skills-install' })).status, 200, 'another action');
    env.tick(3000);
    assert.equal((await env.post(b)).status, 200);
  } finally {
    await env.close();
  }
  // A live trial waits for the terminal to start: a second writing action meanwhile gets 409 busy
  let release;
  const gate = new Promise((r) => (release = r));
  const slowSpawn = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    gate.then(() => child.emit('spawn'));
    return child;
  };
  const env2 = await startServer(w, { spawn: slowSpawn });
  try {
    const first = env2.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
    await new Promise((r) => setTimeout(r, 100));
    const second = await env2.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'busy');
    release();
    assert.equal((await first).status, 200);
    env2.tick(3000); // the refused request still counts for the repeat rule
    const third = await env2.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] });
    assert.equal(third.status, 200);
  } finally {
    await env2.close();
  }
});

// ---------------- page helpers (public/js/contextmenu.js, i18n.js) ----------------
test('page: default targets match the server rule for every tool combination; item names follow the server pattern', () => {
  const tools = ['claude-code', 'codex', 'gemini-cli', 'antigravity', 'copilot', 'cursor'];
  for (let mask = 0; mask < 1 << tools.length; mask++) {
    const via = tools.filter((_, i) => mask & (1 << i));
    assert.deepEqual(skillTargets(via), defaultTargets(via), via.join(','));
  }
  const lib = (name, extra = {}) => ({ kind: 'skill', name, source: 'library', ...extra });
  assert.equal(libraryInstallable(lib('Mixed.Case_1')), true);
  for (const name of ['bad name', 'a.', '-a', 'x'.repeat(65)]) assert.equal(libraryInstallable(lib(name)), false, name);
  assert.equal(libraryInstallable(lib('ok', { source: 'personal' })), false, 'only library items');
  assert.equal(libraryInstallable(lib('ok', { kind: 'plugin' })), false);
});

test('page: suggested skills — Install opens only after a successful preview in the same mode with the same selection and targets; skills need a target', () => {
  const p = { id: 'cc' };
  const data = { items: [{ kind: 'skill', name: 'a', installed: false }, { kind: 'agent', name: 'b', installed: true }, { kind: 'skill', name: 'c', installed: false }] };
  assert.deepEqual([...defaultSuggestSelection(data.items)], ['skill:a', 'skill:c'], 'not installed ones first');
  const st = { sel: new Set(['skill:a']), targets: new Set(['claude']), busy: '', preview: null };
  let v = suggestFlowView(p, data, st, 'dry');
  assert.equal(v.installEnabled, false);
  assert.equal(v.previewDisabled, false);
  st.preview = { ok: true, key: v.key, mode: 'dry' };
  assert.equal(suggestFlowView(p, data, st, 'dry').installEnabled, true);
  assert.equal(suggestFlowView(p, data, st, 'live').installEnabled, false, 'a dry preview never opens Install in live mode');
  st.targets.add('agents');
  assert.equal(suggestFlowView(p, data, st, 'dry').installEnabled, false, 'another target set needs a new preview');
  st.targets.clear();
  v = suggestFlowView(p, data, st, 'dry');
  assert.equal(v.previewDisabled, true, 'a skill needs a target');
  st.sel = new Set(['agent:b']);
  assert.equal(suggestFlowView(p, data, st, 'dry').previewDisabled, false, 'an agent alone needs none (always .claude)');
  st.sel = new Set();
  assert.equal(suggestFlowView(p, data, st, 'dry').tryDisabled, true);
  assert.equal(selectionKey('p', [{ kind: 'skill', name: 'b' }, { kind: 'skill', name: 'a' }], ['agents', 'claude']), selectionKey('p', [{ kind: 'skill', name: 'a' }, { kind: 'skill', name: 'b' }], ['claude', 'agents']));
});

test('page: install into a project — no default project, registered projects first, remove only where installed, an agent always targets claude', () => {
  const r = { id: 'agent:x', kind: 'agent', name: 'x', installedIn: ['a'] };
  const projects = [
    { id: 'c', name: 'C', kind: 'adhoc', path: 'D:\\Work\\c' },
    { id: 'b', name: 'B', kind: 'registered', path: 'D:\\Work\\b' },
    { id: 'a', name: 'A', kind: 'registered', path: 'D:\\Work\\a' },
  ];
  const list = installTargets(projects);
  assert.deepEqual(list.map((p) => p.id), ['a', 'b', 'c'], 'registered projects first, each group by name');
  let v = itemInstallView(r, list, { targets: new Set() }, 'live');
  assert.equal(v.proj, null, 'no project is chosen for the user, even though one without the item exists');
  assert.equal(v.previewDisabled, true);
  assert.equal(v.removeEnabled, false);
  assert.deepEqual(v.targets, ['claude']);
  assert.equal(v.here, false);
  v = itemInstallView(r, list, { proj: 'b', targets: new Set() }, 'live');
  assert.equal(v.proj, 'b');
  assert.equal(v.previewDisabled, false, 'an agent needs no target');
  assert.equal(v.here, false);
  assert.equal(v.removeEnabled, false, 'nothing to remove where the item is not installed');
  v = itemInstallView(r, list, { proj: 'a', targets: new Set() }, 'live');
  assert.equal(v.here, true);
  assert.equal(v.removeEnabled, true);
  const s = { id: 'skill:y', kind: 'skill', name: 'y', installedIn: [] };
  v = itemInstallView(s, list, { proj: 'a', targets: new Set() }, 'live');
  assert.equal(v.previewDisabled, true, 'a skill needs a target');
  assert.equal(itemInstallView(s, [], {}, 'live').proj, null);
});

test('page: every plan reason and error code the server sends has a text in English and Turkish', () => {
  const reasons = ['new', 'missing', 'library-changed', 'kit-changed', 'up-to-date', 'modified', 'project-owned', 'not-installed', 'not-in-library', 'reparse-point', 'outside-project', 'outside-library', 'too-large', 'too-many-files', 'too-many-folders', 'too-deep', 'not-convertible', 'unchanged', 'trial', 'trial-claude-code-only', 'same', 'conflict', 'replace', 'bad-name', 'duplicate', 'bad-category', 'not-found', 'exists', 'error'];
  const errors = ['legacy-hub', 'no-hub', 'not-a-project', 'broad-folder', 'folder-missing', 'not-local', 'project-in-hub', 'personal-folder', 'bad-name', 'bad-items', 'bad-kind', 'too-many-items', 'bad-targets', 'bad-category', 'bad-source', 'source-missing', 'source-is-root', 'source-is-home', 'source-in-hub', 'reparse-point', 'busy', 'record-broken', 'record-write-failed', 'nothing-to-try', 'unsafe-path', 'terminal-missing', 'launch-failed', 'trial-failed', 'app-folder-missing', 'too-large', 'too-many-files', 'not-found', 'internal'];
  try {
    for (const lang of ['en', 'tr']) {
      setLanguage(lang);
      for (const code of reasons) {
        assert.ok(PAGE_STRINGS[lang][`skReason_${code}`], `${lang} reason ${code}`);
        assert.equal(planRows([{ op: 'skip', kind: 'skill', name: 'n', reason: code }])[0].reasonText, PAGE_STRINGS[lang][`skReason_${code}`]);
      }
      for (const code of errors) {
        assert.ok(PAGE_STRINGS[lang][`skErr_${code}`], `${lang} error ${code}`);
        assert.equal(skillErrorText({ ok: false, status: 409, error: code }), PAGE_STRINGS[lang][`skErr_${code}`]);
      }
      for (const code of ['unexpected-field', 'missing-field', 'bad-field', 'bad-project-id']) assert.equal(skillErrorText({ ok: false, status: 400, error: code }), PAGE_STRINGS[lang].skErr_malformed);
      assert.equal(skillErrorText({ ok: false, status: 429, error: 'x' }), PAGE_STRINGS[lang].skErr_repeat);
      assert.equal(skillErrorText({ ok: false, modeChanged: true }), PAGE_STRINGS[lang]['skErr_mode-changed']);
      assert.equal(skillErrorText({ ok: false, status: 0, error: 'actions-off' }), PAGE_STRINGS[lang].actionsOffError);
      assert.match(skillErrorText({ ok: false, status: 500, error: 'brand-new-code' }), /brand-new-code/);
      for (const op of ['copy', 'update', 'skip', 'remove']) assert.ok(PAGE_STRINGS[lang][`skOp_${op}`], op);
      for (const target of TARGETS) assert.ok(PAGE_STRINGS[lang][`skTarget_${target}`], target);
    }
  } finally {
    setLanguage('en');
  }
});

test('page: runAction sends only the skill fields; after a 403 with a changed mode nothing is resent; import batches stay under the body limit', async () => {
  _resetActionsForTest();
  let server = { mode: 'dry', token: 'a'.repeat(64) };
  const posts = [];
  const f = async (url, opts = {}) => {
    if (url === '/api/actions') return { ok: true, status: 200, json: async () => ({ mode: server.mode, token: server.token }) };
    posts.push(JSON.parse(opts.body));
    const ok = opts.headers['X-SiberSentez-Token'] === server.token;
    return { ok, status: ok ? 200 : 403, json: async () => (ok ? { ok: true, mode: server.mode } : { ok: false, error: 'token' }) };
  };
  await initActions({ fetch: f });
  const r = await runAction({ action: 'skills-install', projectId: 'cc', items: [{ kind: 'skill', name: 'a', path: 'C:\\bad' }], targets: ['claude'], command: 'calc', plan: 'yes' }, { fetch: f });
  assert.equal(r.ok, true);
  assert.deepEqual(posts[0], { action: 'skills-install', projectId: 'cc', items: [{ kind: 'skill', name: 'a' }], targets: ['claude'] }, 'extra fields are never sent');
  assert.deepEqual(actionBody({ action: 'library-import', source: 'D:\\s', items: [{ path: 'x', category: 'web', replace: true, other: 1 }] }), { action: 'library-import', source: 'D:\\s', items: [{ path: 'x', category: 'web', replace: true }] });
  // The server restarted in live mode: the dry request is not resent
  server = { mode: 'live', token: 'b'.repeat(64) };
  const again = await runAction({ action: 'skills-install', projectId: 'cc', items: [{ kind: 'skill', name: 'a' }] }, { fetch: f });
  assert.equal(again.modeChanged, true);
  assert.equal(posts.length, 2, 'one refused post, no resend');
  _resetActionsForTest();
  assert.equal((await runAction({ action: 'skills-preview' }, { fetch: f })).error, 'actions-off', 'never sent while off');
  // 60 long picks: batches of at most 25 items and under 4096 bytes
  const picks = Array.from({ length: 60 }, (_, i) => ({ path: `${'deep/'.repeat(20)}skill-${i}`, category: 'web' }));
  const batches = importBatches('D:\\source', picks);
  assert.equal(batches.flat().length, 60);
  for (const b of batches) {
    assert.ok(b.length <= MAX_SKILL_ITEMS);
    assert.ok(Buffer.byteLength(JSON.stringify({ action: 'library-import', source: 'D:\\source', items: b })) < 4096);
  }
});

// ---------------- review round 1 (docs/skills-flow.md §2.3, §3.7, §3.8, §3.9) ----------------

// Installs through the action in live mode (the way a real install happens), then closes the server
async function installLive(w, projectId, items, targets) {
  const env = await startServer(w);
  try {
    const r = await env.post({ action: 'skills-install', projectId, items, ...(targets ? { targets } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  } finally {
    await env.close();
  }
}

const sibersentezEntries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('.sibersentez-')) : []);

test('remove: an item changed after the plan is not deleted; the user change stays and so does the record (hashed again right before the delete)', async () => {
  const w = world();
  const p = w.dir('cc');
  await installLive(w, 'cc', [ALPHA, GAMMA]);
  const rec = readInstalls(w.hub);
  const plan = planRemove({ project: { id: 'cc' }, dir: p, items: [ALPHA, GAMMA], targets: ['claude'], installs: rec.installs });
  assert.deepEqual(ops(plan), ['remove:skill:alpha-skill@claude:unchanged', 'remove:agent:gamma-agent@claude:unchanged']);
  // Changed between the plan and the delete
  const skill = path.join(p, '.claude', 'skills', 'alpha-skill');
  const agent = path.join(p, '.claude', 'agents', 'gamma-agent.md');
  write(path.join(skill, 'mine.txt'), 'user change');
  write(agent, 'edited after the plan');
  const r = executeRemove({ plan, hubDir: w.hub, installs: rec.installs, rows: rec.rows });
  assert.deepEqual(r, { removed: 0, forgotten: 0, recordError: false });
  assert.deepEqual(ops(plan), ['skip:skill:alpha-skill@claude:modified', 'skip:agent:gamma-agent@claude:modified']);
  assert.equal(fs.readFileSync(path.join(skill, 'mine.txt'), 'utf8'), 'user change');
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), fm('alpha-skill', 'React components'));
  assert.equal(fs.readFileSync(agent, 'utf8'), 'edited after the plan');
  assert.equal(readInstalls(w.hub).installs.length, 2, 'the record still lists both');
});

test('install: an update whose destination changed after the plan is not written; the user change stays (the hash is checked again at the copy)', async () => {
  const w = world();
  const p = w.dir('cc');
  await installLive(w, 'cc', [ALPHA, GAMMA]);
  write(path.join(w.lib, 'web', 'skills', 'alpha-skill', 'scripts', 'run.txt'), 'echo alpha v2');
  write(path.join(w.lib, 'design', 'agents', 'gamma-agent.md'), fm('gamma-agent', 'v2'));
  const rec = readInstalls(w.hub);
  const before = JSON.stringify(rec.rows);
  const plan = planInstall({ project: { id: 'cc' }, dir: p, items: [ALPHA, GAMMA], targets: ['claude'], library: listLibrary(w.hub), installs: rec.installs });
  assert.deepEqual(ops(plan), ['update:skill:alpha-skill@claude:library-changed', 'update:agent:gamma-agent@claude:library-changed']);
  // Changed between the plan and the copy
  const skill = path.join(p, '.claude', 'skills', 'alpha-skill');
  const agent = path.join(p, '.claude', 'agents', 'gamma-agent.md');
  write(path.join(skill, 'mine.txt'), 'user change');
  write(agent, 'edited after the plan');
  const r = executeInstall({ plan, project: { id: 'cc' }, hubDir: w.hub, installs: rec.installs, rows: rec.rows });
  assert.deepEqual(r, { copied: 0, updated: 0, recordError: false });
  assert.deepEqual(ops(plan), ['skip:skill:alpha-skill@claude:modified', 'skip:agent:gamma-agent@claude:modified']);
  assert.equal(fs.readFileSync(path.join(skill, 'mine.txt'), 'utf8'), 'user change');
  assert.equal(fs.readFileSync(path.join(skill, 'scripts', 'run.txt'), 'utf8'), 'echo alpha', 'the old version stays');
  assert.equal(fs.readFileSync(agent, 'utf8'), 'edited after the plan');
  assert.equal(JSON.stringify(readInstalls(w.hub).rows), before, 'the record is unchanged');
  for (const d of [path.join(p, '.claude'), path.join(p, '.claude', 'skills'), path.join(p, '.claude', 'agents')]) assert.deepEqual(sibersentezEntries(d), [], d);
});

test('install staging: copies are staged in <p>/.claude or <p>/.agents, never in skills/ or agents/; an old copy that cannot be deleted is not an error and the record gets the new hash', async () => {
  const w = world();
  const p = w.dir('both');
  await installLive(w, 'both', [ALPHA, GAMMA]);
  write(path.join(w.lib, 'web', 'skills', 'alpha-skill', 'scripts', 'run.txt'), 'echo alpha v2');
  write(path.join(w.lib, 'design', 'agents', 'gamma-agent.md'), fm('gamma-agent', 'v2'));
  const rec = readInstalls(w.hub);
  const plan = planInstall({ project: { id: 'both' }, dir: p, items: [ALPHA, GAMMA], targets: ['claude', 'agents'], library: listLibrary(w.hub), installs: rec.installs });
  assert.deepEqual(ops(plan), ['update:skill:alpha-skill@claude:library-changed', 'update:skill:alpha-skill@agents:library-changed', 'update:agent:gamma-agent@claude:library-changed']);
  const asked = [];
  const r = executeInstall({
    plan,
    project: { id: 'both' },
    hubDir: w.hub,
    installs: rec.installs,
    rows: rec.rows,
    removeTree: (x) => {
      asked.push(x);
      throw Object.assign(new Error(`cannot delete ${x}`), { code: 'EBUSY' });
    },
  });
  assert.deepEqual(r, { copied: 0, updated: 3, recordError: false }, 'the old copy that stayed is not an error');
  assert.deepEqual(asked.map((x) => path.dirname(x)), [path.join(p, '.claude'), path.join(p, '.agents'), path.join(p, '.claude')], 'staged in the tool folder');
  assert.ok(asked.every((x) => LEFTOVER_RE.test(path.basename(x))));
  for (const t of ['.claude', '.agents']) {
    const d = path.join(p, t, 'skills', 'alpha-skill');
    assert.equal(fs.readFileSync(path.join(d, 'scripts', 'run.txt'), 'utf8'), 'echo alpha v2', 'the new copy is in place');
    assert.deepEqual(sibersentezEntries(path.join(p, t, 'skills')), [], `nothing staged inside ${t}/skills`);
  }
  assert.deepEqual(sibersentezEntries(path.join(p, '.claude', 'agents')), [], 'nothing staged inside .claude/agents');
  const after = readInstalls(w.hub).installs;
  for (const x of after) assert.equal(x.hash, treeHash(x.path), `${x.name}@${x.target}: the record has the hash of the new copy`);
  // The next install sees the item up to date (the record followed the new copy)
  assert.deepEqual(ops(planInstall({ project: { id: 'both' }, dir: p, items: [ALPHA, GAMMA], targets: ['claude', 'agents'], library: listLibrary(w.hub), installs: after })).map((s) => s.split(':').pop()), ['up-to-date', 'up-to-date', 'up-to-date']);
  // Server start: the leftovers go
  assert.equal(sibersentezEntries(path.join(p, '.claude')).length + sibersentezEntries(path.join(p, '.agents')).length, 3);
  assert.deepEqual(sweepLeftovers(w.hub, { claudeDir: CLAUDE }), { removed: 3, kept: 0 });
  assert.equal(sibersentezEntries(path.join(p, '.claude')).length + sibersentezEntries(path.join(p, '.agents')).length, 0);
});

test('start sweep: only .sibersentez-(tmp|old)-<12 hex> entries of the recorded tool folders and of the library go; nothing else, no link followed, never the personal folder', async () => {
  const w = world();
  const p = w.dir('both');
  await installLive(w, 'both', [ALPHA, GAMMA]);
  const tag = (n) => String(n).padStart(12, 'a');
  const precious = path.join(w.base, 'precious');
  write(path.join(precious, 'data.txt'), 'data');
  const removable = [
    path.join(p, '.claude', `.sibersentez-tmp-${tag(1)}`), // where a copy stages now
    path.join(p, '.claude', 'skills', `.sibersentez-old-${tag(2)}`), // where an older version staged
    path.join(p, '.agents', `.sibersentez-old-${tag(3)}`), // an agent's set-aside copy is a file
    path.join(w.lib, `.sibersentez-old-${tag(4)}`),
    path.join(w.lib, 'web', 'skills', `.sibersentez-tmp-${tag(5)}`),
  ];
  write(path.join(removable[0], 'SKILL.md'), 'x');
  junction(precious, path.join(removable[0], 'inside-link'));
  write(path.join(removable[1], 'SKILL.md'), 'x');
  write(removable[2], 'x');
  write(path.join(removable[3], 'SKILL.md'), 'x');
  write(path.join(removable[4], 'SKILL.md'), 'x');
  // Must stay: other names, a link with the name, a user folder, an unrecorded project, a tool folder reached
  // through a junction, the personal Claude folder
  const stays = [path.join(p, '.claude', '.sibersentez-tmp-notes'), path.join(p, '.claude', `.sibersentez-new-${tag(6)}`), path.join(p, '.claude', 'my-folder'), path.join(w.dir('cc'), '.claude', `.sibersentez-tmp-${tag(7)}`)];
  for (const s of stays) write(path.join(s, 'keep.txt'), 'keep');
  const linkLeft = path.join(p, '.claude', `.sibersentez-tmp-${tag(8)}`);
  junction(precious, linkLeft);
  const outsideTools = path.join(w.base, 'outside-tools');
  write(path.join(outsideTools, `.sibersentez-tmp-${tag(9)}`, 'keep.txt'), 'keep');
  junction(outsideTools, path.join(w.dir('codex'), '.claude'));
  write(path.join(CLAUDE, `.sibersentez-tmp-${tag(10)}`, 'keep.txt'), 'keep');
  // A tool folder reached through a junction higher up (the project folder itself is a link)
  const realProj = path.join(w.base, 'real-proj');
  write(path.join(realProj, '.claude', `.sibersentez-tmp-${tag(12)}`, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(realProj, '.claude', 'skills'), { recursive: true });
  const linkedProj = path.join(w.base, 'linked-proj');
  junction(realProj, linkedProj);
  const rows = readInstalls(w.hub).rows;
  rows.push({ project: 'lp', target: 'claude', kind: 'skill', name: 'w', path: path.join(linkedProj, '.claude', 'skills', 'w'), hash: 'h' });
  rows.push({ project: 'codex', target: 'claude', kind: 'skill', name: 'x', path: path.join(w.dir('codex'), '.claude', 'skills', 'x'), hash: 'h' });
  rows.push({ project: 'cc', target: 'claude', kind: 'skill', name: 'y', path: path.join(CLAUDE, 'skills', 'y'), hash: 'h' });
  rows.push({ project: 'cc', target: 'claude', kind: 'skill', name: 'z', path: `${p}\\.claude::$INDEX_ALLOCATION\\skills\\z`, hash: 'h' });
  write(path.join(w.hub, 'registry', 'installs.json'), JSON.stringify({ version: 1, installs: rows }));
  const r = sweepLeftovers(w.hub, { claudeDir: CLAUDE });
  assert.deepEqual(r, { removed: 5, kept: 1 }, 'the link with the leftover name is counted as kept');
  for (const x of removable) assert.ok(!exists(x), x);
  for (const s of stays) assert.ok(exists(path.join(s, 'keep.txt')), s);
  assert.ok(fs.lstatSync(linkLeft).isSymbolicLink(), 'a link with the name is left alone');
  assert.equal(fs.readFileSync(path.join(precious, 'data.txt'), 'utf8'), 'data', 'no link was followed');
  assert.ok(exists(path.join(outsideTools, `.sibersentez-tmp-${tag(9)}`, 'keep.txt')), 'a tool folder reached through a junction is not swept');
  assert.ok(exists(path.join(realProj, '.claude', `.sibersentez-tmp-${tag(12)}`, 'keep.txt')), 'nor one whose project folder is a junction');
  assert.ok(exists(path.join(CLAUDE, `.sibersentez-tmp-${tag(10)}`, 'keep.txt')), 'the personal Claude folder is never swept');
  assert.ok(exists(path.join(p, '.claude', 'skills', 'alpha-skill', 'SKILL.md')) && exists(path.join(w.lib, 'web', 'skills', 'alpha-skill', 'SKILL.md')), 'items stay');
  fs.rmSync(path.join(CLAUDE, `.sibersentez-tmp-${tag(10)}`), { recursive: true });
  // A legacy hub is never swept
  const lw = world({ legacy: true });
  write(path.join(lw.hub, 'library', `.sibersentez-tmp-${tag(11)}`, 'x.txt'), 'x');
  assert.deepEqual(sweepLeftovers(lw.hub), { removed: 0, kept: 0 });
  assert.deepEqual(sweepLeftovers(null), { removed: 0, kept: 0 });
});

test('record: rows this version cannot use are kept, in place, when an install or a remove rewrites the record', async () => {
  const w = world();
  const odd = [null, 'text row', { project: 'cc' }, { project: 'cc', target: 'claude', kind: 'skill', name: 'future', path: 'C:\\x', hash: 'h', extra: { v: 2 } }, 42];
  write(path.join(w.hub, 'registry', 'installs.json'), JSON.stringify({ version: 1, installs: odd }));
  assert.equal(readInstalls(w.hub).installs.length, 1, 'only the row with every field is used');
  await installLive(w, 'cc', [ALPHA]);
  let rows = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'installs.json'), 'utf8')).installs;
  assert.deepEqual(rows.slice(0, odd.length), odd, 'kept in place after an install');
  assert.equal(rows.length, odd.length + 1);
  assert.equal(rows.at(-1).name, 'alpha-skill');
  const env = await startServer(w);
  try {
    const r = await env.post({ action: 'skills-remove', projectId: 'cc', items: [ALPHA] });
    assert.deepEqual(r.json.result, { executed: true, removed: 1, forgotten: 0 });
  } finally {
    await env.close();
  }
  rows = JSON.parse(fs.readFileSync(path.join(w.hub, 'registry', 'installs.json'), 'utf8')).installs;
  assert.deepEqual(rows, odd, 'kept after a remove');
});

test('project rules: a ":" after the drive letter is not-local; a broad folder is broad through its real path (8.3 short name, stream form) too', async (t) => {
  const w = world();
  const cc = w.dir('cc');
  const longHome = path.join(w.base, 'longhomefolder');
  for (const d of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(longHome, d), { recursive: true });
  const projects = {
    ads: cc + '::$INDEX_ALLOCATION',
    adsI30: cc + ':$I30:$INDEX_ALLOCATION',
    root: 'C:\\::$INDEX_ALLOCATION',
    desktopAds: path.join(longHome, 'Desktop') + '::$INDEX_ALLOCATION',
  };
  const catalog = { getProject: (id) => (projects[id] ? { id, name: id, kind: 'registered', path: projects[id], via: [] } : null) };
  for (const id of Object.keys(projects)) {
    const r = resolveProject({ catalog, projectId: id, hubDir: w.hub, homeDir: longHome, claudeDir: CLAUDE });
    assert.equal(r.error, 'not-local', id);
    assert.equal(r.status, 409, id);
  }
  // Through the action: refused, nothing written into the folder
  const env = await startServer({ ...w, catalog: { ...w.catalog, getProject: (id) => (id === 'ads' ? { id, name: 'Ads', kind: 'registered', path: projects.ads, via: [] } : null) } });
  try {
    const r = await env.post({ action: 'skills-install', projectId: 'ads', items: [ALPHA] });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'not-local');
  } finally {
    await env.close();
  }
  assert.ok(!exists(path.join(cc, '.claude')));
  // The broad rule on the real path: a stream form of Desktop is Desktop
  assert.equal(isBroadFolder(path.join(longHome, 'Desktop') + '::$INDEX_ALLOCATION', longHome), true);
  assert.equal(isBroadFolder(path.join(longHome, 'Desktop', 'proj'), longHome), false);
  // 8.3 short names (a volume without them has nothing to check)
  const shortHome = path.join(w.base, 'LONGHO~1');
  if (!fs.existsSync(shortHome) || realPath(shortHome) !== realPath(longHome)) return t.skip('this volume makes no 8.3 short names');
  const short = { home: shortHome, desk: path.join(shortHome, 'Desktop'), docs: path.join(shortHome, 'Documents') };
  const c2 = { getProject: (id) => (short[id] ? { id, name: id, kind: 'registered', path: short[id], via: [] } : null) };
  for (const id of Object.keys(short)) assert.equal(resolveProject({ catalog: c2, projectId: id, hubDir: w.hub, homeDir: longHome, claudeDir: CLAUDE }).error, 'broad-folder', id);
  assert.equal(resolveProject({ catalog: c2, projectId: 'desk', hubDir: w.hub, homeDir: shortHome }).error, 'broad-folder', 'the home folder given short');
  fs.mkdirSync(path.join(shortHome, 'Desktop', 'real-project'), { recursive: true });
  const c3 = { getProject: (id) => ({ id, name: id, kind: 'registered', path: path.join(shortHome, 'Desktop', 'real-project'), via: [] }) };
  assert.equal(resolveProject({ catalog: c3, projectId: 'p', hubDir: w.hub, homeDir: longHome, claudeDir: CLAUDE }).ok, true, 'a project inside Desktop is fine');
});

test('install plan: a library item over the folder or depth limit is measured before it is hashed and none of its files is read', async () => {
  const w = world();
  const wide = path.join(w.lib, 'web', 'skills', 'wide-skill');
  write(path.join(wide, 'SKILL.md'), fm('wide-skill'));
  for (let i = 0; i < 501; i++) fs.mkdirSync(path.join(wide, 'd', `x${i}`), { recursive: true });
  const deep = path.join(w.lib, 'web', 'skills', 'deep-skill');
  write(path.join(deep, 'SKILL.md'), fm('deep-skill'));
  write(path.join(deep, ...Array.from({ length: 17 }, (_, i) => `l${i}`), 'f.txt'), 'x');
  const reads = [];
  const read = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    reads.push(String(p));
    return read.call(this, p, ...rest);
  };
  let plan;
  try {
    plan = planInstall({ project: { id: 'cc' }, dir: w.dir('cc'), items: [{ kind: 'skill', name: 'wide-skill' }, { kind: 'skill', name: 'deep-skill' }], targets: ['claude'], library: listLibrary(w.hub), installs: [] });
  } finally {
    fs.readFileSync = read;
  }
  assert.deepEqual(ops(plan), ['skip:skill:wide-skill@claude:too-many-folders', 'skip:skill:deep-skill@claude:too-deep']);
  assert.ok(!reads.some((p) => p.startsWith(wide) || p.startsWith(deep)), reads.join(','));
  // Not tried either
  const env = await startServer(w);
  try {
    const t = await env.post({ action: 'skills-trial', projectId: 'cc', items: [{ kind: 'skill', name: 'wide-skill' }, { kind: 'skill', name: 'deep-skill' }] });
    assert.equal(t.json.error, 'nothing-to-try');
    assert.deepEqual(ops(t.json.plan), ['skip:skill:wide-skill:too-many-folders', 'skip:skill:deep-skill:too-deep']);
  } finally {
    await env.close();
  }
});

test('logs: errors of the skill flow are logged by code only (never a message or a path); log notes of the skill actions are English', async () => {
  const w = world();
  const secret = path.join(w.base, 'SECRET-PATH');
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    // 1) The catalog reload after a live install fails
    const env1 = await startServer(w, {
      onChange: () => {
        throw Object.assign(new Error(`reload failed at ${secret}`), { code: 'EPERM' });
      },
    });
    try {
      assert.equal((await env1.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] })).status, 200);
      env1.tick();
      assert.equal((await env1.post({ action: 'skills-install', projectId: 'cc', items: [ALPHA] })).json.plan[0].reason, 'up-to-date');
    } finally {
      await env1.close();
    }
    // 2) A skill action fails inside (the project breaks while the plan is made)
    const tricky = {
      name: 'Tricky',
      kind: 'registered',
      path: w.dir('none'),
      via: [],
      get id() {
        throw new Error(`boom in ${secret}`);
      },
    };
    const env2 = await startServer({ ...w, catalog: { ...w.catalog, getProject: (id) => (id === 'tricky' ? tricky : null) } });
    try {
      const r = await env2.post({ action: 'skills-install', projectId: 'tricky', items: [ALPHA], targets: ['claude'] });
      assert.equal(r.status, 500);
      assert.equal(r.json.error, 'internal');
      assert.match(env2.logs.at(-1), / skills-install tricky 500 error$/);
      // A refused request of a skill action carries the English note
      const n = await env2.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
      assert.equal(n.status, 404);
      assert.match(env2.logs.at(-1), / skills-trial cc 404 validation$/);
    } finally {
      await env2.close();
    }
    // 3) The catalog itself throws while a skill action is validated
    const env3 = await startServer({
      ...w,
      catalog: {
        ...w.catalog,
        getProject: () => {
          throw new Error(`catalog broke at ${secret}`);
        },
      },
    });
    try {
      const r = await env3.post({ action: 'skills-preview', projectId: 'cc', items: [ALPHA] });
      assert.equal(r.status, 500);
      assert.match(env3.logs.at(-1), / skills-preview cc 500 error$/);
    } finally {
      await env3.close();
    }
    // 4) Busy: one writing action at a time
    let release;
    const gate = new Promise((r) => (release = r));
    const env4 = await startServer(w, {
      spawn: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        gate.then(() => child.emit('spawn'));
        return child;
      },
    });
    const first = env4.post({ action: 'skills-trial', projectId: 'cc', items: [ALPHA] });
    try {
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((await env4.post({ action: 'skills-install', projectId: 'cc', items: [BETA] })).status, 409);
      assert.match(env4.logs.at(-1), / skills-install cc 409 busy$/);
    } finally {
      // The first request always gets its answer, so a failed check above is reported as itself
      release();
      await first;
      await env4.close();
    }
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errors, ['catalog reload failed: EPERM', 'skill action failed: no-code', 'action failed: no-code']);
  assert.ok(!errors.some((l) => l.includes('SECRET') || l.includes(w.base)), errors.join('\n'));
});

// ---------------- restore points through the actions (docs/restore.md) ----------------
test('restore points: preview and a dry apply write nothing; live goes back after keeping the present; the read route lists the points; a bad or foreign id is refused', async () => {
  const { createPoint, listPoints } = await import('../server/restore.mjs');
  const w = world();
  const p = w.dir('cc');
  write(path.join(p, 'index.html'), 'v1');
  const point = createPoint({ hubDir: w.hub, projectId: 'cc', dir: p, reason: 'ai-start', now: () => Date.UTC(2026, 8, 20) });
  assert.equal(point.ok, true);
  write(path.join(p, 'index.html'), 'v2 by the AI');
  write(path.join(p, 'extra.js'), 'later');
  const dry = await startServer(w, { mode: 'dry' });
  const before = snapshotTree(p);
  try {
    const pre = await dry.post({ action: 'restore-preview', projectId: 'cc', pointId: point.id });
    assert.equal(pre.status, 200, JSON.stringify(pre.json));
    assert.deepEqual([pre.json.changed, pre.json.missing, pre.json.added], [['index.html'], [], ['extra.js']]);
    assert.deepEqual(pre.json.counts, { changed: 1, missing: 0, added: 1 });
    assert.deepEqual(pre.json.result, { executed: false });
    dry.tick();
    const d = await dry.post({ action: 'restore-apply', projectId: 'cc', pointId: point.id });
    assert.equal(d.json.mode, 'dry');
    assert.deepEqual(d.json.result, { executed: false });
    assert.deepEqual(snapshotTree(p), before, 'preview mode: the project is untouched');
    for (const [body, code] of [
      [{ action: 'restore-apply', projectId: 'cc', pointId: '../x' }, 'bad-point-id'],
      [{ action: 'restore-apply', projectId: 'cc' }, 'missing-field'],
      [{ action: 'restore-apply', projectId: 'cc', pointId: point.id, path: 'C:\\x' }, 'unexpected-field'],
      [{ action: 'restore-preview', projectId: 'codex', pointId: point.id }, 'point-missing'],
      [{ action: 'restore-preview', projectId: 'broad', pointId: point.id }, 'broad-folder'],
    ]) {
      dry.tick();
      const r = await dry.post(body);
      assert.equal(r.json.error, code, JSON.stringify(body));
    }
  } finally {
    await dry.close();
  }
  // An AI session still working in the project: going back is refused, nothing changes
  const busy = await startServer(w, { ingest: { sessions: new Map([['s1', { projectId: 'cc', live: true }]]) } });
  try {
    const r = await busy.post({ action: 'restore-apply', projectId: 'cc', pointId: point.id });
    assert.equal(r.json.error, 'ai-working');
    assert.deepEqual(snapshotTree(p), before);
  } finally {
    await busy.close();
  }
  // Any AI tool running in the project's embedded terminal counts too (Codex here, it has no session logs); a plain
  // shell does not, a tool in another project does not, and once it ended the way back is open again
  const docked = await startServer(w);
  try {
    const job = 'J' + 'd'.repeat(32);
    assert.deepEqual(docked.actions.terminalState({ sessions: [{ id: 't1', projectId: 'cc', ai: true, tool: 'codex', jobId: job, startedAt: 1 }] }), { ok: true, reason: 'saved' });
    let r = await docked.post({ action: 'restore-apply', projectId: 'cc', pointId: point.id });
    assert.equal(r.json.error, 'ai-working');
    assert.deepEqual(snapshotTree(p), before);
    docked.actions.terminalState({ sessions: [{ id: 't2', projectId: 'cc', ai: false, tool: null }, { id: 't3', projectId: 'other', ai: true, tool: 'gemini' }], ended: { id: 't1', projectId: 'cc', ai: true, tool: 'codex', jobId: job, exitCode: 0 } });
    assert.deepEqual(docked.actions.dockSessions().map((x) => x.id), ['t2', 't3'], 'the last report wins: Codex ended');
    r = await docked.post({ action: 'restore-preview', projectId: 'cc', pointId: point.id });
    assert.equal(r.json.error, undefined, "a plain shell and another project's tool do not lock this project");
    // Malformed reports are refused or cleaned field by field; they never mark a project busy
    assert.deepEqual(docked.actions.terminalState({ sessions: 'x' }), { ok: false, reason: 'invalid' });
    docked.actions.terminalState({ sessions: [{ id: '../x', projectId: 'cc', ai: true }, { id: 't9', projectId: 'cc', ai: true, tool: 'Bad Tool', jobId: 'nope' }] });
    assert.deepEqual(docked.actions.dockSessions(), [{ id: 't9', projectId: 'cc', ai: true, tool: null, jobId: null, startedAt: null, running: true }], 'no running field (an older shell): still running');
    docked.actions.terminalState({ sessions: [] });
  } finally {
    await docked.close();
  }
  const live = await startServer(w);
  try {
    // The plan the person saw: a stale digest is refused, the preview's is taken
    let r = await live.post({ action: 'restore-apply', projectId: 'cc', pointId: point.id, planId: '0000000000000000' });
    assert.equal(r.json.error, 'plan-changed');
    assert.deepEqual(snapshotTree(p), before);
    live.tick();
    const seen = await live.post({ action: 'restore-preview', projectId: 'cc', pointId: point.id });
    live.tick();
    r = await live.post({ action: 'restore-apply', projectId: 'cc', pointId: point.id, planId: seen.json.planId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.result, { executed: true, restored: 1, removed: 1, failed: [] });
    assert.equal(fs.readFileSync(path.join(p, 'index.html'), 'utf8'), 'v1');
    assert.equal(fs.existsSync(path.join(p, 'extra.js')), false);
    const pts = listPoints({ hubDir: w.hub, projectId: 'cc' });
    assert.equal(pts[0].id, r.json.before, 'the present was kept first');
    assert.equal(pts[0].reason, 'before-restore');
  } finally {
    await live.close();
  }
  // The read route: the points, newest first; an unknown project 404
  const handler = createHandler({ ingest: { sessions: new Map() }, catalog: w.catalog, clients: new Set(), port: 1, publicDir: PUBLIC_DIR });
  const call = (url) => new Promise((resolve) => {
    const res = new EventEmitter();
    res.writeHead = (s) => (res.status = s);
    res.setHeader = () => {};
    res.end = (data) => resolve({ status: res.status, json: JSON.parse(String(data)) });
    handler({ method: 'GET', url, headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' } }, res);
  });
  const list = await call('/api/projects/cc/restore');
  assert.equal(list.status, 200);
  assert.equal(list.json.points.length, 2);
  assert.deepEqual(list.json.points.map((x) => x.reason), ['before-restore', 'ai-start']);
  assert.equal((await call('/api/projects/nope/restore')).status, 404);
});
